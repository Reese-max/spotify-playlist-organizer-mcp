import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Duplex, Writable } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { canDisableEcho, readHiddenLine } from "../src/hidden-input.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AUTH_SCRIPT = join(root, "scripts", "youtube-auth.js");

// Stand-ins for real process.stdin/stdout TTY streams: input is a duplex we
// feed bytes into, output captures every byte the code under test writes.
class FakeTtyInput extends Duplex {
  constructor() {
    super();
    this.isTTY = true;
    this.isRaw = false;
    this.rawCalls = [];
  }

  _read() {}

  _write(_chunk, _encoding, callback) {
    callback();
  }

  setRawMode(mode) {
    this.rawCalls.push(mode);
    this.isRaw = mode;
    return this;
  }

  feed(bytes) {
    this.push(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes);
  }
}

class FakeTtyOutput extends Writable {
  constructor() {
    super();
    this.isTTY = true;
    this.chunks = [];
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(chunk.toString());
    callback();
  }

  get text() {
    return this.chunks.join("");
  }
}

function childEnv(extra = {}) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    USERPROFILE: process.env.USERPROFILE ?? "",
    SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "",
    // Empty values shield the child from a developer's real .env —
    // process.loadEnvFile never overrides keys that already exist.
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    ...extra,
  };
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

test("hidden input resolves the typed passphrase without echoing it", { timeout: 20_000 }, async () => {
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput();
  const pending = readHiddenLine({ input, output, prompt: "Passphrase: " });

  assert.equal(input.isRaw, true, "echo must be disabled before the prompt is shown");
  assert.equal(output.text, "Passphrase: ");
  input.feed("SENTINEL-PHRASE\r");

  assert.equal(await pending, "SENTINEL-PHRASE");
  assert.equal(
    output.text.includes("SENTINEL-PHRASE"),
    false,
    "typed passphrase was written back to the terminal",
  );
  assert.deepEqual(input.rawCalls, [true, false], "raw mode was not restored after entry");
});

test("terminals that cannot disable echo fail closed instead of prompting", { timeout: 20_000 }, async () => {
  const output = new FakeTtyOutput();

  const notTty = new FakeTtyInput();
  notTty.isTTY = false;
  await assert.rejects(
    readHiddenLine({ input: notTty, output }),
    (error) => error.code === "HIDDEN_INPUT_UNAVAILABLE",
  );

  const noRawMode = new FakeTtyInput();
  noRawMode.setRawMode = undefined;
  await assert.rejects(
    readHiddenLine({ input: noRawMode, output }),
    (error) => error.code === "HIDDEN_INPUT_UNAVAILABLE",
  );

  const ioctlFails = new FakeTtyInput();
  ioctlFails.setRawMode = () => {
    throw new Error("ioctl failed");
  };
  await assert.rejects(
    readHiddenLine({ input: ioctlFails, output }),
    (error) => error.code === "HIDDEN_INPUT_UNAVAILABLE",
  );
});

test("canDisableEcho only accepts a TTY pair with raw-mode support", () => {
  assert.equal(canDisableEcho(new FakeTtyInput(), new FakeTtyOutput()), true);
  assert.equal(canDisableEcho({ isTTY: false }, new FakeTtyOutput()), false);
  assert.equal(canDisableEcho({ isTTY: true }, new FakeTtyOutput()), false);
  assert.equal(canDisableEcho(new FakeTtyInput(), { isTTY: false }), false);
  assert.equal(canDisableEcho(null, new FakeTtyOutput()), false);
});

test("backspace edits, escape sequences are swallowed, and nothing echoes", { timeout: 20_000 }, async () => {
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput();

  // "s<BS>ecret<Right>b<Tab>é<BS><Enter>" — every byte processed like a real
  // terminal delivers them: backspace deletes a code point, arrows inject
  // nothing, tab is ignored.
  const edited = readHiddenLine({ input, output });
  input.feed("s\x7fecret\x1b[Cb\té\x7f\r");
  assert.equal(await edited, "ecretb");
  assert.equal(output.text.includes("ecretb"), false);
  assert.equal(output.text.includes("s"), false);
});

test("Ctrl+C aborts entry without leaking text and restores the terminal", { timeout: 20_000 }, async () => {
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput();
  const pending = readHiddenLine({ input, output, prompt: "Passphrase: " });
  input.feed("partial-secret\x03");
  await assert.rejects(pending, (error) => error.code === "HIDDEN_INPUT_CANCELLED");
  assert.equal(output.text.includes("partial-secret"), false);
  assert.equal(input.isRaw, false, "terminal left in raw mode after abort");
});

test("Escape followed by a printable key keeps the key instead of eating it", { timeout: 20_000 }, async () => {
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput();
  const pending = readHiddenLine({ input, output });
  // A bare ESC (or ESC + an unknown two-byte sequence) must not swallow the
  // next character: the stored passphrase has to match what was typed.
  input.feed("ab\x1bXcd\r");
  assert.equal(await pending, "abXcd");
  assert.equal(output.text.includes("abXcd"), false);
});

test("SS3 escape sequences are swallowed whole", { timeout: 20_000 }, async () => {
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput();
  const pending = readHiddenLine({ input, output });
  // "a" + SS3 F1 ("\x1bOP") + "b<Enter>" — the two SS3 payload bytes vanish.
  input.feed("a\x1bOPb\r");
  assert.equal(await pending, "ab");
});

test("malformed UTF-8 fails closed instead of storing a corrupted passphrase", { timeout: 20_000 }, async () => {
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput();
  const pending = readHiddenLine({ input, output });
  // 0xC3 opens a two-byte character that never arrives; "(" is not a
  // continuation byte, so the typed value is not valid UTF-8.
  input.feed(Buffer.from([0x61, 0xc3, 0x28, 0x0d]));
  await assert.rejects(pending, (error) => error.code === "HIDDEN_INPUT_INVALID");
  assert.equal(output.text.includes("a"), false);
});

test("an unterminated multi-byte character is refused instead of mangled", { timeout: 20_000 }, async () => {
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput();
  const pending = readHiddenLine({ input, output });
  // "a" + the first two bytes of "あ" (0xE3 0x81) then Enter.
  input.feed(Buffer.from([0x61, 0xe3, 0x81, 0x0d]));
  await assert.rejects(pending, (error) => error.code === "HIDDEN_INPUT_INVALID");
});

test("a stdin error after entry does not crash the process", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "hidden-input-"));
  const script = join(dir, "post-entry-error.mjs");
  await writeFile(script, [
    'import { Duplex } from "node:stream";',
    `import { readHiddenLine } from ${JSON.stringify(pathToFileURL(join(root, "src", "hidden-input.js")).href)};`,
    "const input = new Duplex({ read() {} });",
    "input.isTTY = true;",
    "input.setRawMode = () => input;",
    "const output = { isTTY: true, write: () => true, on: () => {}, off: () => {}, once: () => {} };",
    "const pending = readHiddenLine({ input, output });",
    'input.push(Buffer.from("ok\\r"));',
    "await pending;",
    'input.emit("error", new Error("EIO after entry"));',
    'await new Promise((r) => setTimeout(r, 50));',
    'console.log("SURVIVED");',
  ].join("\n"));
  const child = spawn(process.execPath, [script], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const [code] = await exited;
  assert.equal(stderr.includes("EIO after entry"), false, "unhandled stream error reached stderr");
  assert.equal(code, 0, "the auth flow would crash on a late stdin error");
  assert.match(stdout, /SURVIVED/);
});

test("Escape then Enter still submits instead of swallowing the key", { timeout: 20_000 }, async () => {
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput();
  const pending = readHiddenLine({ input, output });
  input.feed("abc\x1b\r");
  assert.equal(await pending, "abc");
});

test("backspace discards a partially delivered multi-byte character", { timeout: 20_000 }, async () => {
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput();
  const pending = readHiddenLine({ input, output });
  // "a" + first byte of "é" in one chunk, then a backspace, then "b<Enter>".
  input.feed(Buffer.from([0x61, 0xc3]));
  input.feed(Buffer.from([0x7f]));
  input.feed("b\r");
  assert.equal(await pending, "ab");
});

test("stream end or error mid-entry fails closed instead of hanging", { timeout: 20_000 }, async () => {
  const ended = new FakeTtyInput();
  const pendingEnd = readHiddenLine({ input: ended, output: new FakeTtyOutput() });
  ended.emit("end");
  await assert.rejects(pendingEnd, (error) => error.code === "HIDDEN_INPUT_UNAVAILABLE");
  assert.equal(ended.isRaw, false);

  const errored = new FakeTtyInput();
  const pendingError = readHiddenLine({ input: errored, output: new FakeTtyOutput() });
  errored.emit("error", new Error("EIO"));
  await assert.rejects(pendingError, (error) => error.code === "HIDDEN_INPUT_UNAVAILABLE");
  assert.equal(errored.isRaw, false);
});

test("a failing prompt write restores raw mode and fails closed", { timeout: 20_000 }, async () => {
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput();
  output.write = () => {
    throw new Error("broken tty");
  };
  await assert.rejects(
    readHiddenLine({ input, output, prompt: "Passphrase: " }),
    (error) => error.code === "HIDDEN_INPUT_UNAVAILABLE",
  );
  assert.equal(input.isRaw, false, "terminal left in raw mode after prompt failure");
});

test("a stream already flowing stays flowing after entry", { timeout: 20_000 }, async () => {
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput();
  input.resume();
  const pending = readHiddenLine({ input, output });
  input.feed("ok\r");
  assert.equal(await pending, "ok");
  assert.equal(input.isPaused(), false, "input was paused even though the caller resumed it");
});

test("stray continuation, C1, and impossible lead bytes are dropped", { timeout: 20_000 }, async () => {
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput();
  const pending = readHiddenLine({ input, output });
  input.feed(Buffer.from([0x61, 0x80, 0x9f, 0xc0, 0xc1, 0xf5, 0xff, 0x62, 0x0d]));
  assert.equal(await pending, "ab");
});

function hasLinuxScriptPty() {
  if (process.platform !== "linux") return false;
  const probe = spawnSync("script", ["-qec", "true", "/dev/null"]);
  return probe.status === 0;
}

test("PTY: the interactive passphrase prompt produces a zero-echo transcript", { timeout: 30_000 }, async (t) => {
  if (!hasLinuxScriptPty()) {
    t.skip("PTY capture requires util-linux script(1) on Linux");
    return;
  }
  const SENTINEL = "SENTINEL-PASSPHRASE-ZERO-ECHO";
  const command = JSON.stringify(process.execPath) + " " + JSON.stringify(AUTH_SCRIPT);
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: root,
    env: childEnv({ YOUTUBE_CREDENTIAL_PASSPHRASE: "" }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let transcript = "";
  child.stdout.on("data", (chunk) => { transcript += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { transcript += chunk.toString("utf8"); });

  try {
    await waitFor(() => transcript.includes("passphrase"));
    child.stdin.write(SENTINEL + "\r");
    await exited;
    assert.match(transcript, /passphrase/i);
    assert.equal(
      transcript.includes(SENTINEL),
      false,
      "typed passphrase appeared in the terminal transcript",
    );
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("PTY: a whitespace-only passphrase is rejected as empty", { timeout: 30_000 }, async (t) => {
  if (!hasLinuxScriptPty()) {
    t.skip("PTY capture requires util-linux script(1) on Linux");
    return;
  }
  const command = JSON.stringify(process.execPath) + " " + JSON.stringify(AUTH_SCRIPT);
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: root,
    env: childEnv({ YOUTUBE_CREDENTIAL_PASSPHRASE: "" }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let transcript = "";
  child.stdout.on("data", (chunk) => { transcript += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { transcript += chunk.toString("utf8"); });

  try {
    await waitFor(() => transcript.includes("passphrase"));
    child.stdin.write("   \r");
    const [code] = await exited;
    assert.equal(code, 1);
    assert.match(transcript, /non-empty credential passphrase/);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("PTY: Ctrl+C at the prompt exits with env guidance and echoes nothing", { timeout: 30_000 }, async (t) => {
  if (!hasLinuxScriptPty()) {
    t.skip("PTY capture requires util-linux script(1) on Linux");
    return;
  }
  const SENTINEL = "SENTINEL-PASSPHRASE-CANCELLED";
  const command = JSON.stringify(process.execPath) + " " + JSON.stringify(AUTH_SCRIPT);
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: root,
    env: childEnv({ YOUTUBE_CREDENTIAL_PASSPHRASE: "" }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let transcript = "";
  child.stdout.on("data", (chunk) => { transcript += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { transcript += chunk.toString("utf8"); });

  try {
    await waitFor(() => transcript.includes("passphrase"));
    child.stdin.write(SENTINEL + "\x03");
    const [code] = await exited;
    assert.equal(code, 1);
    assert.equal(transcript.includes(SENTINEL), false, "cancelled passphrase was echoed");
    assert.match(transcript, /YOUTUBE_CREDENTIAL_PASSPHRASE is required/);
    assert.match(transcript, /local shell/);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("without a TTY the script fails closed with env guidance before any OAuth work", { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, [AUTH_SCRIPT], {
    cwd: root,
    env: childEnv({ YOUTUBE_CREDENTIAL_PASSPHRASE: "" }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });

  const [code] = await exited;
  assert.equal(code, 1);
  assert.match(output, /YOUTUBE_CREDENTIAL_PASSPHRASE is required/);
  assert.match(output, /local shell/);
  assert.equal(
    output.includes("Open this URL"),
    false,
    "OAuth callback server started before credentials were secured",
  );
});

test("an env-provided passphrase skips interactive entry entirely", { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, [AUTH_SCRIPT], {
    cwd: root,
    env: childEnv({ YOUTUBE_CREDENTIAL_PASSPHRASE: "env-provided-pass" }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });

  const [code] = await exited;
  assert.equal(code, 1);
  assert.match(output, /GOOGLE_CLIENT_ID is required/);
  assert.equal(output.includes("Credential passphrase"), false);
  assert.equal(output.includes("env-provided-pass"), false);
});
