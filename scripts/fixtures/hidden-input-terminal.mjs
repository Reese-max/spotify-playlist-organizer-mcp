// Synthetic native-terminal acceptance fixture. Never load local credentials,
// .env files, an OAuth callback, or a provider. No isTTY/raw-mode mocks.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { stdin as input, stdout as output } from "node:process";
import { readHiddenLine } from "../../src/hidden-input.js";

const mode = process.argv[2];
const expected = process.env.SYNTHETIC_EXPECTED ?? "";
const timeout = setTimeout(() => {
  console.error("FAIL: native terminal fixture timed out");
  process.exit(1);
}, 10_000);
const forbid = () => { throw new Error("FAIL: forbidden credential/OAuth/network operation"); };
const exists = fs.existsSync;
fs.existsSync = (path) => /(?:^|[/\\])\.env$/.test(String(path)) ? false : exists(path);
process.loadEnvFile = forbid;
http.createServer = forbid;
net.Socket.prototype.connect = forbid;
globalThis.fetch = forbid;
syncBuiltinESMExports();

// GetConsoleMode observes the real shared ConPTY input buffer. The tiny child
// inherits the console input handle; stdout is piped only for the mode number.
function consoleMode() {
  if (process.platform !== "win32") return null;
  const probe = spawnSync(process.env.SYNTHETIC_PYTHON, ["-c", [
    "import ctypes",
    "from ctypes import wintypes as w",
    "k=ctypes.WinDLL('kernel32',use_last_error=True)",
    "k.GetStdHandle.argtypes=[w.DWORD];k.GetStdHandle.restype=w.HANDLE",
    "k.GetConsoleMode.argtypes=[w.HANDLE,ctypes.POINTER(w.DWORD)]",
    "h=k.GetStdHandle(w.DWORD(-10));m=w.DWORD()",
    "assert k.GetConsoleMode(h,ctypes.byref(m)), 'native console mode unavailable'",
    "print(m.value)",
  ].join("\n")], { stdio: ["inherit", "pipe", "pipe"], timeout: 2_000 });
  assert.ok(probe.status === 0, "native console mode probe failed");
  const value = Number(probe.stdout.toString().trim());
  assert.ok(Number.isInteger(value), "invalid native console mode");
  return value;
}

async function cookedEchoProbe(expectedEcho = "VISIBLE_RESTORE_CHECK") {
  // Consume an ordinary cooked-mode line without readline changing raw mode
  // or echoing input in JavaScript. The host must observe the kernel echo.
  const line = new Promise((resolve) => {
    let text = "";
    input.on("data", function consume(chunk) {
      text += chunk.toString();
      if (!text.includes("\n")) return;
      input.off("data", consume);
      input.pause();
      resolve(text.replaceAll("\r", "").trim());
    });
  });
  output.write("COOKED_READY\n");
  input.resume();
  assert.ok(await line === expectedEcho, "cooked input restoration failed");
}

async function main() {
  const isHost = mode.startsWith("host-");
  assert.ok(isHost ? !input.isTTY && !output.isTTY : input.isTTY && output.isTTY,
    "fixture requires the actual requested terminal/pipe handles");
  input.pause();
  const beforeMode = isHost ? null : consoleMode();
  const wasRaw = input.isRaw === true;
  const exitsBefore = process.listenerCount("exit");
  console.log("NATIVE", JSON.stringify({ platform: process.platform, node: process.version,
    stdinTTY: input.isTTY === true, stdoutTTY: output.isTTY === true, beforeMode }));

  if (mode === "echo-control") {
    await cookedEchoProbe(expected);
  } else if (mode.startsWith("auth-") || isHost) {
    let failure;
    try { await import("../youtube-auth.js"); } catch (error) { failure = error; }
    const message = mode === "auth-empty" ? /non-empty credential passphrase/
      : ["auth-cancel", "host-missing"].includes(mode) ? /YOUTUBE_CREDENTIAL_PASSPHRASE is required/
        : /GOOGLE_CLIENT_ID is required/;
    assert.ok(failure && message.test(failure.message), "auth did not fail at the expected pre-OAuth boundary");
  } else {
    let outcome;
    const pending = readHiddenLine({ input, output, prompt: "HIDDEN_READY\n" });
    const duringMode = consoleMode();
    if (duringMode !== null) assert.ok((duringMode & 6) === 0, "native console echo/line mode stayed enabled");
    console.log("RAW_READY");
    try { outcome = await pending; } catch (error) { outcome = error.code; }
    assert.ok(outcome === expected, "hidden input outcome differs from synthetic expectation");
  }

  assert.ok((input.isRaw === true) === wasRaw, "raw mode was not restored");
  assert.ok(input.isPaused(), "paused input was not restored");
  assert.ok(process.listenerCount("exit") === exitsBefore, "exit cleanup listener leaked");
  const afterMode = isHost ? null : consoleMode();
  if (beforeMode !== null) assert.ok(afterMode === beforeMode, "native console mode was not restored");
  console.log("RESULT", JSON.stringify({ mode, restored: true, afterMode }));
  if (!isHost && mode !== "echo-control") await cookedEchoProbe();
  clearTimeout(timeout);
  console.log("PASS");
}

main().catch((error) => {
  clearTimeout(timeout);
  console.error("FAIL:", error.message);
  process.exitCode = 1;
  input.pause();
});
