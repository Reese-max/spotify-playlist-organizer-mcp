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

// GetConsoleMode observes the real shared ConPTY input buffer. CONIN$ avoids
// redirected standard handles in the tiny probe child; it never reads input.
function consoleMode() {
  if (process.platform !== "win32") return null;
  const probe = spawnSync(process.env.SYNTHETIC_PYTHON, ["-c", [
    "import ctypes,sys",
    "from ctypes import wintypes as w",
    "k=ctypes.WinDLL('kernel32',use_last_error=True)",
    "def require(ok,stage):",
    "    if not ok:",
    "        print('CONSOLE_PROBE_ERROR '+stage+'='+str(ctypes.get_last_error()),file=sys.stderr)",
    "        sys.exit(1)",
    "k.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,ctypes.c_void_p,w.DWORD,w.DWORD,w.HANDLE];k.CreateFileW.restype=w.HANDLE",
    "k.AttachConsole.argtypes=[w.DWORD];k.AttachConsole.restype=w.BOOL",
    "k.CloseHandle.argtypes=[w.HANDLE];k.CloseHandle.restype=w.BOOL",
    "k.GetConsoleMode.argtypes=[w.HANDLE,ctypes.POINTER(w.DWORD)]",
    "h=k.CreateFileW('CONIN$',0x80000000,3,None,3,0,None)",
    "if h==w.HANDLE(-1).value:",
    "    require(ctypes.get_last_error() in (2,6),'open')",
    "    require(k.AttachConsole(w.DWORD(-1)),'attach')",
    "    h=k.CreateFileW('CONIN$',0x80000000,3,None,3,0,None)",
    "require(h!=w.HANDLE(-1).value,'open')",
    "m=w.DWORD()",
    "require(k.GetConsoleMode(h,ctypes.byref(m)),'mode')",
    "k.CloseHandle(h)",
    "print(m.value)",
  ].join("\n")], { stdio: ["inherit", "pipe", "pipe"], timeout: 2_000 });
  const diagnostic = probe.stderr?.toString().match(/CONSOLE_PROBE_ERROR [a-z]+=\d+/)?.[0] ?? "none";
  assert.ok(probe.status === 0, "native console mode probe failed: status=" + probe.status
    + ", error=" + (probe.error?.code ?? "none") + ", signal=" + (probe.signal ?? "none")
    + ", stage=" + diagnostic);
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
  console.log("FIXTURE_STARTED", JSON.stringify({ platform: process.platform, node: process.version,
    stdinTTY: input.isTTY === true, stdoutTTY: output.isTTY === true }));
  assert.ok(isHost ? !input.isTTY && !output.isTTY : input.isTTY && output.isTTY,
    "fixture requires the actual requested terminal/pipe handles");
  input.pause();
  const beforeMode = isHost ? null : consoleMode();
  let duringMode = null;
  if (beforeMode !== null) assert.ok((beforeMode & 7) === 7, "native console did not start in cooked mode");
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
    duringMode = consoleMode();
    if (duringMode !== null) assert.ok((duringMode & 7) === 0, "native console echo/line/processed mode stayed enabled");
    console.log("RAW_READY");
    try { outcome = await pending; } catch (error) { outcome = error.code; }
    assert.ok(outcome === expected, "hidden input outcome differs from synthetic expectation");
  }

  assert.ok((input.isRaw === true) === wasRaw, "raw mode was not restored");
  assert.ok(input.isPaused(), "paused input was not restored");
  assert.ok(process.listenerCount("exit") === exitsBefore, "exit cleanup listener leaked");
  const afterMode = isHost ? null : consoleMode();
  // Node/libuv's Windows NORMAL mode explicitly sets ECHO|LINE|PROCESSED
  // (0x7), rather than preserving unrelated flags in the entire DWORD. Verify
  // those native semantics and the same-console cooked echo below; record all
  // mode values so canonicalization remains visible in acceptance evidence.
  if (beforeMode !== null) assert.ok((afterMode & 7) === (beforeMode & 7),
    "native console echo/line/processed mode was not restored: before=" + beforeMode + ", after=" + afterMode);
  console.log("RESULT", JSON.stringify({ mode, restored: true, beforeMode, duringMode, afterMode }));
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
