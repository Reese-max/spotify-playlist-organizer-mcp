const CTRL_C = 0x03;
const CTRL_D = 0x04;
const BACKSPACE = 0x08;
const CR = 0x0d;
const LF = 0x0a;
const ESC = 0x1b;
const CSI_OPEN = 0x5b; // "["
const SS3_OPEN = 0x4f; // "O"
const DEL = 0x7f;

export class HiddenInputError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "HiddenInputError";
    this.code = code;
    if (options.cause) this.cause = options.cause;
  }
}

// Hidden input is only possible when stdin is a TTY whose line discipline
// supports raw mode (kernel echo off) and stdout can show the prompt.
// Anything less must fail closed — never guess that typed input is hidden.
export function canDisableEcho(input, output) {
  return Boolean(
    input?.isTTY === true
      && output?.isTTY === true
      && typeof input.setRawMode === "function",
  );
}

// Index where an incomplete trailing UTF-8 sequence starts inside `bytes`, or
// bytes.length when the tail already ends on a complete character boundary.
// A tail made only of continuation bytes is malformed input, not a partially
// delivered character, and counts as complete.
function incompleteTailStart(bytes) {
  for (let i = bytes.length - 1; i >= 0 && i >= bytes.length - 4; i--) {
    const byte = bytes[i];
    if ((byte & 0x80) === 0) return bytes.length;
    if ((byte & 0xc0) !== 0x80) {
      const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
      return i + length === bytes.length ? bytes.length : i;
    }
  }
  return bytes.length;
}

// Reads one line with terminal echo fully disabled: raw mode stops the kernel
// from echoing keystrokes and this function never writes input bytes back to
// the output, so a typed secret leaves no trace in scrollback, recordings, or
// PTY captures. Escape sequences (arrow keys etc.) are swallowed, backspace
// removes one code point, Ctrl+C/Ctrl+D aborts, and a stream end, error, or
// close fails closed instead of hanging. Resolves on Enter.
export function readHiddenLine({ input, output, prompt = "" } = {}) {
  if (!canDisableEcho(input, output)) {
    return Promise.reject(new HiddenInputError(
      "HIDDEN_INPUT_UNAVAILABLE",
      "This terminal cannot guarantee hidden input; typed secrets would be echoed.",
    ));
  }

  let wasRaw;
  let wasPaused;
  try {
    wasRaw = input.isRaw === true;
    wasPaused = typeof input.isPaused !== "function" || input.isPaused();
  } catch (cause) {
    return Promise.reject(new HiddenInputError(
      "HIDDEN_INPUT_UNAVAILABLE",
      "This terminal cannot guarantee hidden input; typed secrets would be echoed.",
      { cause },
    ));
  }
  // UTF-8 bytes received but not yet decoded — kept out of `captured` so
  // backspace can discard a partially delivered character instead of leaving
  // a replacement character behind.
  let pending = Buffer.alloc(0);
  let captured = "";

  const restoreInput = () => {
    try {
      input.setRawMode(wasRaw);
    } catch {
      // Best effort — the caller is already leaving the prompt path.
    }
    if (wasPaused) {
      try {
        input.pause();
      } catch {
        // Best effort — a dead input stream must not mask the real outcome.
      }
    }
  };
  const restoreOnExit = () => {
    try {
      input.setRawMode(wasRaw);
    } catch {
      // Process is exiting; nothing else can be done.
    }
  };

  return new Promise((resolve, reject) => {
    // 0 = normal, 1 = saw ESC, 2 = inside CSI (until final byte), 3 = inside SS3.
    let escape = 0;

    const detach = () => {
      input.off("data", onData);
      input.off("end", onStreamEnd);
      input.off("error", onStreamEnd);
      input.off("close", onStreamEnd);
      output.off("error", onStreamEnd);
    };

    const finish = (error) => {
      detach();
      process.off("exit", restoreOnExit);
      restoreInput();
      try {
        output.write("\n");
      } catch {
        // The terminal output is already gone; the outcome below still stands.
      }
      captured += pending.toString("utf8");
      pending = Buffer.alloc(0);
      if (error) reject(error);
      else resolve(captured);
    };

    const onStreamEnd = (cause) => finish(new HiddenInputError(
      "HIDDEN_INPUT_UNAVAILABLE",
      "The terminal stream ended before the passphrase was submitted.",
      { cause: cause instanceof Error ? cause : undefined },
    ));

    const onData = (original) => {
      const chunk = typeof original === "string" ? Buffer.from(original, "utf8") : original;
      let done = null;
      for (const byte of chunk) {
        // Enter and cancellation always win — even mid escape sequence.
        if (byte === CR || byte === LF) {
          done = "finish";
          break;
        }
        if (byte === CTRL_C || byte === CTRL_D) {
          done = "cancel";
          break;
        }
        if (escape === 3) {
          escape = 0;
        } else if (escape === 2) {
          if (byte >= 0x40 && byte <= 0x7e) escape = 0;
        } else if (escape === 1) {
          escape = byte === ESC ? 1 : byte === CSI_OPEN ? 2 : byte === SS3_OPEN ? 3 : 0;
        } else if (byte === ESC) {
          escape = 1;
        } else if (byte === BACKSPACE || byte === DEL) {
          if (pending.length > 0) pending = Buffer.alloc(0);
          else captured = [...captured].slice(0, -1).join("");
        } else if (byte >= 0x20) {
          // ASCII and real UTF-8 lead bytes start a character; continuation
          // bytes only count while a lead byte is still open. Stray
          // continuation/C1 bytes and impossible leads (0xC0-0xC1, 0xF5+)
          // are dropped instead of becoming invisible passphrase garbage.
          const starter = byte < 0x80 || (byte >= 0xc2 && byte <= 0xf4);
          const continuation = byte >= 0x80 && byte <= 0xbf;
          if (starter || (continuation && pending.length > 0)) {
            pending = Buffer.concat([pending, Buffer.of(byte)]);
            const complete = incompleteTailStart(pending);
            captured += pending.subarray(0, complete).toString("utf8");
            pending = pending.subarray(complete);
          }
        }
        // Other C0 control bytes (tab, etc.) are ignored.
      }
      if (done === "finish") finish(null);
      else if (done === "cancel") {
        finish(new HiddenInputError(
          "HIDDEN_INPUT_CANCELLED",
          "Passphrase entry cancelled.",
        ));
      }
    };

    try {
      input.setRawMode(true);
    } catch (cause) {
      reject(new HiddenInputError(
        "HIDDEN_INPUT_UNAVAILABLE",
        "This terminal cannot guarantee hidden input; typed secrets would be echoed.",
        { cause },
      ));
      return;
    }
    // Registered before the prompt write so the terminal is restored even if
    // writing the prompt fails or the process dies mid-entry.
    process.once("exit", restoreOnExit);
    // Listeners attach before the prompt so an already-flowing input cannot
    // drop keystrokes typed between the prompt write and the attach.
    input.on("data", onData);
    input.once("end", onStreamEnd);
    input.once("error", onStreamEnd);
    input.once("close", onStreamEnd);
    output.once("error", onStreamEnd);
    try {
      output.write(prompt);
    } catch (cause) {
      detach();
      process.off("exit", restoreOnExit);
      restoreInput();
      reject(new HiddenInputError(
        "HIDDEN_INPUT_UNAVAILABLE",
        "This terminal cannot guarantee hidden input; typed secrets would be echoed.",
        { cause },
      ));
      return;
    }
    input.resume();
  });
}
