"""Fake-only native POSIX PTY / Windows ConPTY acceptance; Python stdlib only.

No fallback to mocked terminal streams. Unsupported native APIs fail the job.
The output capture is intentionally separate from the synthetic input stream.
"""
import ctypes
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "scripts" / "fixtures" / "hidden-input-terminal.mjs"
NODE = shutil.which("node")
TIMEOUT = 8
VT = re.compile(rb"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]")


def visible(data):
    return VT.sub(b"", data)


class PosixTerminal:
    def __init__(self, args, env):
        import pty
        self.master, self.slave = pty.openpty()
        self.proc = subprocess.Popen(args, cwd=ROOT, env=env, stdin=self.slave,
                                     stdout=self.slave, stderr=self.slave,
                                     start_new_session=True)
        self.buffer = bytearray()

    def pump(self):
        import select
        if select.select([self.master], [], [], 0.02)[0]:
            self.buffer.extend(os.read(self.master, 65536))

    def write(self, data):
        os.write(self.master, data)

    def echo(self):
        import termios
        return bool(termios.tcgetattr(self.slave)[3] & termios.ECHO)

    def wait(self):
        code = self.proc.wait(timeout=TIMEOUT)
        return code

    def close(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(timeout=2)
        # Keep the slave open so the master does not raise EIO while draining.
        import select
        while select.select([self.master], [], [], 0.05)[0]:
            self.buffer.extend(os.read(self.master, 65536))
        os.close(self.master)
        os.close(self.slave)


class WindowsTerminal:
    def __init__(self, args, env):
        from ctypes import wintypes as w
        self.k = k = ctypes.WinDLL("kernel32", use_last_error=True)
        H = w.HANDLE
        P = ctypes.c_void_p
        size = ctypes.c_size_t

        class Coord(ctypes.Structure):
            _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]

        class StartupInfo(ctypes.Structure):
            _fields_ = [("cb", w.DWORD), ("reserved", w.LPWSTR), ("desktop", w.LPWSTR),
                        ("title", w.LPWSTR), ("x", w.DWORD), ("y", w.DWORD),
                        ("xsize", w.DWORD), ("ysize", w.DWORD), ("xchars", w.DWORD),
                        ("ychars", w.DWORD), ("fill", w.DWORD), ("flags", w.DWORD),
                        ("show", w.WORD), ("reserved2size", w.WORD), ("reserved2", P),
                        ("stdin", H), ("stdout", H), ("stderr", H)]

        class StartupInfoEx(ctypes.Structure):
            _fields_ = [("info", StartupInfo), ("attributes", P)]

        class ProcessInfo(ctypes.Structure):
            _fields_ = [("process", H), ("thread", H), ("pid", w.DWORD), ("tid", w.DWORD)]

        declarations = {
            "CreatePipe": ([ctypes.POINTER(H), ctypes.POINTER(H), P, w.DWORD], w.BOOL),
            "CreatePseudoConsole": ([Coord, H, H, w.DWORD, ctypes.POINTER(H)], ctypes.c_long),
            "InitializeProcThreadAttributeList": ([P, w.DWORD, w.DWORD, ctypes.POINTER(size)], w.BOOL),
            "UpdateProcThreadAttribute": ([P, size, size, P, size, P, P], w.BOOL),
            "DeleteProcThreadAttributeList": ([P], None),
            "CreateProcessW": ([w.LPCWSTR, w.LPWSTR, P, P, w.BOOL, w.DWORD, P,
                                w.LPCWSTR, P, ctypes.POINTER(ProcessInfo)], w.BOOL),
            "ReadFile": ([H, P, w.DWORD, ctypes.POINTER(w.DWORD), P], w.BOOL),
            "WriteFile": ([H, P, w.DWORD, ctypes.POINTER(w.DWORD), P], w.BOOL),
            "WaitForSingleObject": ([H, w.DWORD], w.DWORD),
            "GetExitCodeProcess": ([H, ctypes.POINTER(w.DWORD)], w.BOOL),
            "TerminateProcess": ([H, w.UINT], w.BOOL),
            "CloseHandle": ([H], w.BOOL), "ClosePseudoConsole": ([H], None),
        }
        for name, (argtypes, restype) in declarations.items():
            fn = getattr(k, name)
            fn.argtypes, fn.restype = argtypes, restype
        self.buffer = bytearray()
        self.handles = []
        self.hpc = H()
        self.pi = ProcessInfo()
        self.attributes = None
        self.attributes_initialized = False
        self.reader = None
        self.reader_error = None
        input_read, self.input_write, self.output_read, output_write = H(), H(), H(), H()
        try:
            self.check(k.CreatePipe(ctypes.byref(input_read), ctypes.byref(self.input_write), None, 0))
            self.handles.extend([input_read, self.input_write])
            self.check(k.CreatePipe(ctypes.byref(self.output_read), ctypes.byref(output_write), None, 0))
            self.handles.extend([self.output_read, output_write])
            hr = k.CreatePseudoConsole(Coord(160, 40), input_read, output_write, 0, ctypes.byref(self.hpc))
            if hr < 0:
                raise RuntimeError("CreatePseudoConsole unavailable: HRESULT " + hex(hr & 0xffffffff))
            self.reader = threading.Thread(target=self.read_output, daemon=True)
            self.reader.start()
            required = size()
            k.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(required))
            self.attributes = ctypes.create_string_buffer(required.value)
            self.check(k.InitializeProcThreadAttributeList(self.attributes, 1, 0, ctypes.byref(required)))
            self.attributes_initialized = True
            self.check(k.UpdateProcThreadAttribute(self.attributes, 0, 0x00020016,
                                                   self.hpc, ctypes.sizeof(H), None, None))
            startup = StartupInfoEx()
            startup.info.cb = ctypes.sizeof(startup)
            startup.attributes = ctypes.cast(self.attributes, P)
            command = ctypes.create_unicode_buffer(subprocess.list2cmdline(args))
            environment = ctypes.create_unicode_buffer("\0".join(
                key + "=" + value for key, value in sorted(env.items(), key=lambda item: item[0].upper())) + "\0\0")
            # EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT.
            self.check(k.CreateProcessW(args[0], command, None, None, False, 0x00080400,
                                         environment, str(ROOT), ctypes.byref(startup), ctypes.byref(self.pi)))
            for handle in [input_read, output_write]:
                k.CloseHandle(handle)
                self.handles.remove(handle)
        except BaseException:
            self.close()
            raise

    @staticmethod
    def check(ok):
        if not ok:
            raise ctypes.WinError(ctypes.get_last_error())

    def read_output(self):
        from ctypes import wintypes as w
        block, count = ctypes.create_string_buffer(65536), w.DWORD()
        while self.k.ReadFile(self.output_read, block, len(block), ctypes.byref(count), None):
            if not count.value:
                return
            self.buffer.extend(block.raw[:count.value])
        error = ctypes.get_last_error()
        if error not in (109, 232):  # broken pipe / no data during teardown
            self.reader_error = error

    def pump(self):
        time.sleep(0.02)  # The separate reader drains synchronous ConPTY output.

    def write(self, data):
        from ctypes import wintypes as w
        count = w.DWORD()
        self.check(self.k.WriteFile(self.input_write, data, len(data), ctypes.byref(count), None))
        assert count.value == len(data), "incomplete ConPTY input write"

    def echo(self):
        return None  # Native GetConsoleMode snapshots come from the fixture.

    def wait(self):
        from ctypes import wintypes as w
        assert self.k.WaitForSingleObject(self.pi.process, TIMEOUT * 1000) == 0, "ConPTY child timed out"
        code = w.DWORD()
        self.check(self.k.GetExitCodeProcess(self.pi.process, ctypes.byref(code)))
        return code.value

    def close(self):
        k = self.k
        if self.pi.process:
            if k.WaitForSingleObject(self.pi.process, 0) != 0:
                k.TerminateProcess(self.pi.process, 1)
                k.WaitForSingleObject(self.pi.process, 2000)
            k.CloseHandle(self.pi.thread)
            k.CloseHandle(self.pi.process)
            self.pi.process = None
        if self.hpc:
            # ClosePseudoConsole can emit a final frame. Keep the reader alive
            # and bound teardown rather than blocking the main thread forever.
            closer = threading.Thread(target=k.ClosePseudoConsole, args=(self.hpc,), daemon=True)
            closer.start()
            closer.join(3)
            assert not closer.is_alive(), "ConPTY teardown timed out"
            self.hpc = None
        if self.reader:
            # Release any retained ConPTY-side pipe handles on setup failure.
            for handle in list(self.handles):
                if handle not in [self.input_write, self.output_read]:
                    k.CloseHandle(handle)
                    self.handles.remove(handle)
            self.reader.join(3)
            assert not self.reader.is_alive(), "ConPTY output did not close"
            assert self.reader_error is None, "ConPTY output read failed"
        if self.attributes_initialized:
            k.DeleteProcThreadAttributeList(self.attributes)
            self.attributes = None
            self.attributes_initialized = False
        for handle in self.handles:
            k.CloseHandle(handle)
        self.handles = []


def wait_for(terminal, marker):
    deadline = time.monotonic() + TIMEOUT
    while marker not in visible(bytes(terminal.buffer)):
        assert time.monotonic() < deadline, "native fixture did not reach " + marker.decode()
        terminal.pump()


def run_terminal(mode, typed, expected, env):
    child_env = dict(env, SYNTHETIC_EXPECTED=expected)
    terminal = (WindowsTerminal if os.name == "nt" else PosixTerminal)(
        [NODE, str(FIXTURE), mode], child_env)
    try:
        marker = b"COOKED_READY" if mode == "echo-control" else b"Credential passphrase" if mode.startswith("auth-") else b"RAW_READY"
        wait_for(terminal, marker)
        if mode != "echo-control" and terminal.echo() is not None:
            assert not terminal.echo(), "native terminal echo stayed enabled"
        terminal.write(typed)
        if mode != "echo-control":
            wait_for(terminal, b"COOKED_READY")
            if terminal.echo() is not None:
                assert terminal.echo(), "native terminal echo was not restored"
            terminal.write(b"VISIBLE_RESTORE_CHECK\r")
        wait_for(terminal, b"PASS")
        assert terminal.wait() == 0, "native fixture failed"
    finally:
        terminal.close()
    capture = bytes(terminal.buffer)
    occurrences = visible(capture).count(b"SENTINEL-NATIVE")
    assert (occurrences > 0) if mode == "echo-control" else (occurrences == 0), "native echo detector failed"
    assert b"Open this URL" not in capture and b"FORBIDDEN" not in capture, "auth crossed its offline boundary"
    if mode != "echo-control":
        assert b"VISIBLE_RESTORE_CHECK" in visible(capture), "native cooked echo restoration was not observed"
    print(json.dumps({"case": mode, "native_tty": True, "sentinel_output_occurrences": occurrences,
                      "echo_detector_positive_control": mode == "echo-control", "restored": True}))


def main():
    assert NODE, "Node.js 24 or newer is required"
    assert sys.platform in ("linux", "darwin", "win32"), "unsupported native terminal platform"
    with tempfile.TemporaryDirectory(prefix="hidden-input-native-") as home:
        env = {"PATH": os.environ.get("PATH", ""), "HOME": home, "USERPROFILE": home,
               "APPDATA": home, "XDG_CONFIG_HOME": home, "TEMP": home, "TMP": home,
               "GOOGLE_CLIENT_ID": "", "GOOGLE_CLIENT_SECRET": "", "YOUTUBE_CREDENTIAL_PASSPHRASE": "",
               "YOUTUBE_CREDENTIAL_FILE": str(Path(home) / "never-created.json"),
               "SYNTHETIC_PYTHON": sys.executable}
        if os.name == "nt":
            env["SystemRoot"] = os.environ["SystemRoot"]
        print(json.dumps({"os": platform.platform(), "architecture": platform.machine(),
                          "node": subprocess.check_output([NODE, "--version"], env=env, text=True).strip(),
                          "terminal": "Win32 ConPTY" if os.name == "nt" else "POSIX openpty"}))
        cases = [
            ("echo-control", b"SENTINEL-NATIVE-POSITIVE\r", "SENTINEL-NATIVE-POSITIVE"),
            ("submit", b"SENTINEL-NATIVE-SUBMIT\r", "SENTINEL-NATIVE-SUBMIT"),
            ("unicode", "SENTINEL-NATIVE-é-🙂-\uFEFF\r".encode(), "SENTINEL-NATIVE-é-🙂-\uFEFF"),
            ("edit", "SENTINEL-NATIVE-🙂\b é\b\bé\r".encode(), "SENTINEL-NATIVE-é"),
            ("cancel", b"SENTINEL-NATIVE-CANCEL\x03", "HIDDEN_INPUT_CANCELLED"),
            ("eof", b"SENTINEL-NATIVE-EOF\x04", "HIDDEN_INPUT_CANCELLED"),
            ("auth-submit", b"SENTINEL-NATIVE-AUTH\r", ""),
            ("auth-cancel", b"SENTINEL-NATIVE-AUTH-CANCEL\x03", ""),
            ("auth-empty", b"   \r", ""),
        ]
        # Positive control uses the same detector as hidden-input assertions.
        for mode, typed, expected in cases:
            run_terminal(mode, typed, expected, env)
        for mode in ["host-missing", "host-env"]:
            child_env = dict(env)
            if mode == "host-env":
                child_env["YOUTUBE_CREDENTIAL_PASSPHRASE"] = "SENTINEL-NATIVE-HOST-ENV"
            result = subprocess.run([NODE, str(FIXTURE), mode], cwd=ROOT, env=child_env,
                                    input=b"", capture_output=True, timeout=TIMEOUT)
            capture = result.stdout + result.stderr
            assert result.returncode == 0 and b"PASS" in capture, "synthetic pipe host failed"
            assert b"SENTINEL-NATIVE" not in capture and b"Open this URL" not in capture, "pipe host leaked input or started OAuth"
            assert not Path(child_env["YOUTUBE_CREDENTIAL_FILE"]).exists(), "credential file unexpectedly created"
            print(json.dumps({"case": mode, "native_tty": False, "fail_closed_before_oauth": True,
                              "sentinel_output_occurrences": 0}))


if __name__ == "__main__":
    main()
