import { describe, expect, it } from 'vitest';
import {
  sandboxDeniedWritePath,
  sandboxDeniedWriteCreatesDirectory,
} from '../../../../src/host/tools/shell/sandboxFailureDiagnostics';

// Fixtures below are raw stderr pasted verbatim from real seatbelt denials
// (macOS `sandbox-exec`, python 3.14.7 / node 24.21.0). Seatbelt read denials
// raise the same `PermissionError: [Errno 1] Operation not permitted` shape as
// write denials, so the traceback frames must tell them apart (PR #2420 review).

// Captured from sandbox-exec -p '(version 1)(allow default)(deny file-write*)' python3 -c "open('/System/x','w')"
const PYTHON_OPEN_W_TRACEBACK = `Traceback (most recent call last):
  File "<string>", line 1, in <module>
    open('/System/x','w')
    ~~~~^^^^^^^^^^^^^^^^^
PermissionError: [Errno 1] Operation not permitted: '/System/x'`;

// Captured from sandbox-exec -p '(version 1)(allow default)(deny file-write*)' python3 /tmp/neo-save.py, where neo-save.py is:
//   def save(path):
//       with open(path, 'wb') as f:
//           f.write(b'x')
//   save('/tmp/neo-y.docx')
const PYTHON_DEEP_SAVE_TRACEBACK = `Traceback (most recent call last):
  File "/tmp/neo-save.py", line 4, in <module>
    save('/tmp/neo-y.docx')
    ~~~~^^^^^^^^^^^^^^^^^^^
  File "/tmp/neo-save.py", line 2, in save
    with open(path, 'wb') as f:
         ~~~~^^^^^^^^^^^^
PermissionError: [Errno 1] Operation not permitted: '/tmp/neo-y.docx'`;

// Captured from sandbox-exec -p '(version 1)(allow default)(deny file-write*)' python3 -c "import zipfile; zipfile.ZipFile('/tmp/neo-z.zip','w')"
const PYTHON_ZIPFILE_W_TRACEBACK = `Traceback (most recent call last):
  File "<string>", line 1, in <module>
    import zipfile; zipfile.ZipFile('/tmp/neo-z.zip','w')
                    ~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^
  File "/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/lib/python3.14/zipfile/__init__.py", line 1462, in __init__
    self.fp = io.open(file, filemode)
              ~~~~~~~^^^^^^^^^^^^^^^^
PermissionError: [Errno 1] Operation not permitted: '/tmp/neo-z.zip'`;

// Captured from sandbox-exec -p '(version 1)(allow default)(deny file-write*)' python3 -c "import os; os.makedirs('/tmp/neo-dir-a/sub')"
// The <frozen os> frames carry no source lines; the makedirs call is the user frame.
const PYTHON_MAKEDIRS_TRACEBACK = `Traceback (most recent call last):
  File "<string>", line 1, in <module>
    import os; os.makedirs('/tmp/neo-dir-a/sub')
               ~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^
  File "<frozen os>", line 226, in makedirs
  File "<frozen os>", line 236, in makedirs
PermissionError: [Errno 1] Operation not permitted: '/tmp/neo-dir-a'`;

// Captured from sandbox-exec -p '(version 1)(allow default)(deny file-write*)' python3 -c "from pathlib import Path; Path('/tmp/neo-dir-b').mkdir(parents=True)"
const PYTHON_PATHLIB_MKDIR_TRACEBACK = `Traceback (most recent call last):
  File "<string>", line 1, in <module>
    from pathlib import Path; Path('/tmp/neo-dir-b').mkdir(parents=True)
                              ~~~~~~~~~~~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^
  File "/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/lib/python3.14/pathlib/__init__.py", line 1011, in mkdir
    os.mkdir(self, mode)
    ~~~~~~~~^^^^^^^^^^^^
PermissionError: [Errno 1] Operation not permitted: '/tmp/neo-dir-b'`;

// Captured from a (allow default) profile plus (deny file-read* (literal "/private/tmp/neo-secret.txt")) (seatbelt resolves /tmp), then:
//   python3 -c "import os; os.stat('/tmp/neo-secret.txt')"
const PYTHON_OS_STAT_READ = `Traceback (most recent call last):
  File "<string>", line 1, in <module>
    import os; os.stat('/tmp/neo-secret.txt')
               ~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^
PermissionError: [Errno 1] Operation not permitted: '/tmp/neo-secret.txt'`;

// Captured from a (allow default) profile plus (deny file-read* (subpath "/private/tmp/neo-privdir")), then:
//   python3 -c "import os; os.listdir('/tmp/neo-privdir')"
const PYTHON_OS_LISTDIR_READ = `Traceback (most recent call last):
  File "<string>", line 1, in <module>
    import os; os.listdir('/tmp/neo-privdir')
               ~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^
PermissionError: [Errno 1] Operation not permitted: '/tmp/neo-privdir'`;

// Captured from the literal read-deny profile above, then: python3 -c "open('/tmp/neo-secret.txt')"
const PYTHON_OPEN_READ = `Traceback (most recent call last):
  File "<string>", line 1, in <module>
    open('/tmp/neo-secret.txt')
    ~~~~^^^^^^^^^^^^^^^^^^^^^^^
PermissionError: [Errno 1] Operation not permitted: '/tmp/neo-secret.txt'`;

// Captured from the literal read-deny profile above, then: python3 -c "open('/tmp/neo-secret.txt','r')"
const PYTHON_OPEN_R_READ = `Traceback (most recent call last):
  File "<string>", line 1, in <module>
    open('/tmp/neo-secret.txt','r')
    ~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^
PermissionError: [Errno 1] Operation not permitted: '/tmp/neo-secret.txt'`;

// Captured from the literal read-deny profile above, then: python3 -c "from pathlib import Path; Path('/tmp/neo-secret.txt').read_text()"
const PYTHON_PATHLIB_READ_TEXT = `Traceback (most recent call last):
  File "<string>", line 1, in <module>
    from pathlib import Path; Path('/tmp/neo-secret.txt').read_text()
                              ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~^^
  File "/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/lib/python3.14/pathlib/__init__.py", line 787, in read_text
    with self.open(mode='r', encoding=encoding, errors=errors, newline=newline) as f:
         ~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/lib/python3.14/pathlib/__init__.py", line 771, in open
    return io.open(self, mode, buffering, encoding, errors, newline)
           ~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
PermissionError: [Errno 1] Operation not permitted: '/tmp/neo-secret.txt'`;

// Captured from sandbox-exec -p '(version 1)(allow default)(deny file-write*)' node -e "require('node:fs').writeFileSync('/System/x','x')"
const NODE_WRITE_TRACEBACK = `node:fs:2482
    return binding.writeFileUtf8(
                   ^

Error: EPERM: operation not permitted, open '/System/x'
    at Object.writeFileSync (node:fs:2482:20)
    at [eval]:1:20
    at runScriptInThisContext (node:internal/vm:219:10)
    at node:internal/process/execution:451:12
    at [eval]-wrapper:6:24
    at runScriptInContext (node:internal/process/execution:449:60)
    at evalFunction (node:internal/process/execution:283:30)
    at evalTypeScript (node:internal/process/execution:295:3)
    at node:internal/main/eval_string:71:3 {
  errno: -1,
  code: 'EPERM',
  syscall: 'open',
  path: '/System/x'
}

Node.js v24.21.0`;

// A re-quoted error line without its traceback proves nothing either way.
const PYTHON_BARE_ERROR_LINE = "PermissionError: [Errno 1] Operation not permitted: '/Users/u/.npmrc'";

// Node raises the same `Error: EPERM: operation not permitted, open '<path>'`
// for a seatbelt read denial and a write denial; only the frames under the
// error line tell them apart (N-SANDBOX-ESCALATE-REACHABILITY). All fixtures
// below were captured with node v24.21.0 against a fresh dir <D> under
// /private/tmp and the profile (seatbelt resolves /tmp, so /private/tmp it is):
//   (version 1)(allow default)(deny file-read-data (literal "<D>/cred.txt"))
//                     (deny file-write* (literal "<D>/w.txt"))
// via `sandbox-exec -f <profile> node -e '<script>'` with stderr redirected.

// Captured with node -e "require('node:fs').readFileSync('<D>/cred.txt','utf8')".
const NODE_READ_FILE_SYNC_TRACEBACK = `node:fs:483
    return binding.readFileUtf8(path, stringToFlags(options.flag));
                   ^

Error: EPERM: operation not permitted, open '/private/tmp/neo-node-denial-fu3-45633/cred.txt'
    at Object.readFileSync (node:fs:483:20)
    at [eval]:1:20
    at runScriptInThisContext (node:internal/vm:219:10)
    at node:internal/process/execution:451:12
    at [eval]-wrapper:6:24
    at runScriptInContext (node:internal/process/execution:449:60)
    at evalFunction (node:internal/process/execution:283:30)
    at evalTypeScript (node:internal/process/execution:295:3)
    at node:internal/main/eval_string:71:3 {
  errno: -1,
  code: 'EPERM',
  syscall: 'open',
  path: '/private/tmp/neo-node-denial-fu3-45633/cred.txt'
}

Node.js v24.21.0`;

// Captured with node -e "(async()=>{ try { await require('node:fs').promises.readFile('<D>/cred.txt','utf8'); } catch(e) { console.error(e); process.exitCode=1; } })()".
const NODE_PROMISES_READ_FILE_TRACEBACK = `Error: EPERM: operation not permitted, open '/private/tmp/neo-node-denial-fu3-45633/cred.txt'
    at async open (node:internal/fs/promises:1345:25)
    at async Object.readFile (node:internal/fs/promises:1996:14)
    at async [eval]:1:19 {
  errno: -1,
  code: 'EPERM',
  syscall: 'open',
  path: '/private/tmp/neo-node-denial-fu3-45633/cred.txt'
}`;

// Captured with node -e "require('node:fs').createReadStream('<D>/cred.txt').resume()" —
// an unhandled stream 'error' prints the `Emitted 'error' event on ReadStream instance at:`
// header instead of call frames; the header names the stream class.
const NODE_CREATE_READ_STREAM_ERROR = `node:events:505
    throw er; // Unhandled 'error' event
    ^

Error: EPERM: operation not permitted, open '/private/tmp/neo-node-denial-fu3-45633/cred.txt'
Emitted 'error' event on ReadStream instance at:
    at emitErrorNT (node:internal/streams/destroy:170:8)
    at emitErrorCloseNT (node:internal/streams/destroy:129:3)
    at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
  errno: -1,
  code: 'EPERM',
  syscall: 'open',
  path: '/private/tmp/neo-node-denial-fu3-45633/cred.txt'
}

Node.js v24.21.0`;

// Captured with node -e "require('node:fs').appendFileSync('<D>/w.txt','x')" —
// appendFileSync frames include writeFileSync, so this stays a proven write.
const NODE_APPEND_WRITE_TRACEBACK = `node:fs:2482
    return binding.writeFileUtf8(
                   ^

Error: EPERM: operation not permitted, open '/private/tmp/neo-node-denial-fu3-45633/w.txt'
    at Object.writeFileSync (node:fs:2482:20)
    at Object.appendFileSync (node:fs:2564:6)
    at [eval]:1:20
    at runScriptInThisContext (node:internal/vm:219:10)
    at node:internal/process/execution:451:12
    at [eval]-wrapper:6:24
    at runScriptInContext (node:internal/process/execution:449:60)
    at evalFunction (node:internal/process/execution:283:30)
    at evalTypeScript (node:internal/process/execution:295:3)
    at node:internal/main/eval_string:71:3 {
  errno: -1,
  code: 'EPERM',
  syscall: 'open',
  path: '/private/tmp/neo-node-denial-fu3-45633/w.txt'
}

Node.js v24.21.0`;

// A bare `EPERM … open '<path>'` line (callback-style errors print e.message
// only) carries no frames, so read vs write is unknowable; returning the path
// is today's pinned contract, not an accident.
const NODE_BARE_ERROR_LINE = "Error: EPERM: operation not permitted, open '/Users/u/.npmrc'";

// `fs.copyFileSync` prints `copyfile '<src>' -> '<dst>'` and, per libuv
// `uv__fs_copyfile`, reports BOTH errors with `req->path` = source. A read
// denial on the source and a write denial on the destination are therefore
// byte-identical apart from the two paths (frames are only
// `at Object.copyFileSync`), so the two cases cannot be told apart from text
// (N-SANDBOX-ESCALATE-REACHABILITY-FU3-FU2).
//
// Captured from a fresh dir <D> under /tmp (the source file MUST exist, else
// ENOENT), node v24.21.0, with a profile denying the SOURCE read (seatbelt
// resolves /tmp, so the rule targets /private/tmp/<D>):
//   sandbox-exec -p '(version 1)(allow default)(deny file-read* (literal "/private/tmp/<D>/src.txt"))' node -e "require('node:fs').copyFileSync('/tmp/<D>/src.txt','/tmp/<D>/out.txt')"
const NODE_COPYFILE_READ_SOURCE_TRACEBACK = `node:fs:3200
  binding.copyFile(
          ^

Error: EPERM: operation not permitted, copyfile '/tmp/neo-node-copyfile-fu2-20021/src.txt' -> '/tmp/neo-node-copyfile-fu2-20021/out.txt'
    at Object.copyFileSync (node:fs:3200:11)
    at [eval]:1:20
    at runScriptInThisContext (node:internal/vm:219:10)
    at node:internal/process/execution:451:12
    at [eval]-wrapper:6:24
    at runScriptInContext (node:internal/process/execution:449:60)
    at evalFunction (node:internal/process/execution:283:30)
    at evalTypeScript (node:internal/process/execution:295:3)
    at node:internal/main/eval_string:71:3 {
  errno: -1,
  code: 'EPERM',
  syscall: 'copyfile',
  path: '/tmp/neo-node-copyfile-fu2-20021/src.txt',
  dest: '/tmp/neo-node-copyfile-fu2-20021/out.txt'
}

Node.js v24.21.0`;

// Captured from the same node v24.21.0 with a profile denying every write, so
// the DESTINATION is the denied operand while the source (/etc/hosts) is
// readable:
//   sandbox-exec -p '(version 1)(allow default)(deny file-write*)' node -e "require('node:fs').copyFileSync('/etc/hosts','/tmp/<D>/out2.txt')"
const NODE_COPYFILE_WRITE_TARGET_TRACEBACK = `node:fs:3200
  binding.copyFile(
          ^

Error: EPERM: operation not permitted, copyfile '/etc/hosts' -> '/tmp/neo-node-copyfile-fu2-20021/out2.txt'
    at Object.copyFileSync (node:fs:3200:11)
    at [eval]:1:20
    at runScriptInThisContext (node:internal/vm:219:10)
    at node:internal/process/execution:451:12
    at [eval]-wrapper:6:24
    at runScriptInContext (node:internal/process/execution:449:60)
    at evalFunction (node:internal/process/execution:283:30)
    at evalTypeScript (node:internal/process/execution:295:3)
    at node:internal/main/eval_string:71:3 {
  errno: -1,
  code: 'EPERM',
  syscall: 'copyfile',
  path: '/etc/hosts',
  dest: '/tmp/neo-node-copyfile-fu2-20021/out2.txt'
}

Node.js v24.21.0`;

describe('sandboxDeniedWritePath', () => {
  it('recognises a Python PermissionError write traceback', () => {
    expect(sandboxDeniedWritePath(PYTHON_OPEN_W_TRACEBACK)).toBe('/System/x');
    expect(sandboxDeniedWriteCreatesDirectory(PYTHON_OPEN_W_TRACEBACK)).toBe(false);
  });

  it('recognises a Python write traceback whose write call is a deep library frame', () => {
    expect(sandboxDeniedWritePath(PYTHON_DEEP_SAVE_TRACEBACK)).toBe('/tmp/neo-y.docx');
    expect(sandboxDeniedWriteCreatesDirectory(PYTHON_DEEP_SAVE_TRACEBACK)).toBe(false);
  });

  it('recognises a Python ZipFile write traceback proven by the mode literal', () => {
    expect(sandboxDeniedWritePath(PYTHON_ZIPFILE_W_TRACEBACK)).toBe('/tmp/neo-z.zip');
    expect(sandboxDeniedWriteCreatesDirectory(PYTHON_ZIPFILE_W_TRACEBACK)).toBe(false);
  });

  it('recognises Python makedirs and pathlib mkdir denials as directory writes', () => {
    expect(sandboxDeniedWritePath(PYTHON_MAKEDIRS_TRACEBACK)).toBe('/tmp/neo-dir-a');
    expect(sandboxDeniedWriteCreatesDirectory(PYTHON_MAKEDIRS_TRACEBACK)).toBe(true);
    expect(sandboxDeniedWritePath(PYTHON_PATHLIB_MKDIR_TRACEBACK)).toBe('/tmp/neo-dir-b');
    expect(sandboxDeniedWriteCreatesDirectory(PYTHON_PATHLIB_MKDIR_TRACEBACK)).toBe(true);
  });

  it('does not treat Python seatbelt read denials as denied writes', () => {
    expect(sandboxDeniedWritePath(PYTHON_OS_STAT_READ)).toBeUndefined();
    expect(sandboxDeniedWritePath(PYTHON_OS_LISTDIR_READ)).toBeUndefined();
    expect(sandboxDeniedWritePath(PYTHON_OPEN_READ)).toBeUndefined();
    expect(sandboxDeniedWritePath(PYTHON_OPEN_R_READ)).toBeUndefined();
    expect(sandboxDeniedWritePath(PYTHON_PATHLIB_READ_TEXT)).toBeUndefined();
    expect(sandboxDeniedWriteCreatesDirectory(PYTHON_OS_STAT_READ)).toBe(false);
  });

  it('does not treat a bare re-quoted PermissionError line as a denied write', () => {
    expect(sandboxDeniedWritePath(PYTHON_BARE_ERROR_LINE)).toBeUndefined();
  });

  it('recognises a Node fs.writeFileSync EPERM traceback', () => {
    expect(sandboxDeniedWritePath(NODE_WRITE_TRACEBACK)).toBe('/System/x');
  });

  it('recognises a Node fs.appendFileSync EPERM traceback (writeFileSync frame among them)', () => {
    expect(sandboxDeniedWritePath(NODE_APPEND_WRITE_TRACEBACK)).toBe('/private/tmp/neo-node-denial-fu3-45633/w.txt');
  });

  it('does not treat Node seatbelt read denials as denied writes', () => {
    expect(sandboxDeniedWritePath(NODE_READ_FILE_SYNC_TRACEBACK)).toBeUndefined();
    expect(sandboxDeniedWritePath(NODE_PROMISES_READ_FILE_TRACEBACK)).toBeUndefined();
    expect(sandboxDeniedWritePath(NODE_CREATE_READ_STREAM_ERROR)).toBeUndefined();
  });

  it('still returns the path for a bare Node EPERM open line with no frames', () => {
    // A callback-style fs.readFile error printed via e.message (or any re-quoted
    // line) has no frames, so read vs write is unknowable; the widen card is the
    // pinned contract for it, kept deliberately (N-SANDBOX-ESCALATE-REACHABILITY).
    expect(sandboxDeniedWritePath(NODE_BARE_ERROR_LINE)).toBe('/Users/u/.npmrc');
  });

  it('still returns the path when the frames are ambiguous (a bare openSync frame)', () => {
    expect(sandboxDeniedWritePath(
      "Error: EPERM: operation not permitted, open '/Users/u/.npmrc'\n"
      + '    at Object.openSync (node:fs:483:20)\n'
      + '    at [eval]:1:1',
    )).toBe('/Users/u/.npmrc');
  });

  it('returns the copyfile DESTINATION (never the source) for a read-denied source', () => {
    const path = sandboxDeniedWritePath(NODE_COPYFILE_READ_SOURCE_TRACEBACK);
    expect(path).toBe('/tmp/neo-node-copyfile-fu2-20021/out.txt');
    expect(path).not.toBe('/tmp/neo-node-copyfile-fu2-20021/src.txt');
  });

  it('returns the copyfile destination, not the readable source, for a write-denied target', () => {
    const path = sandboxDeniedWritePath(NODE_COPYFILE_WRITE_TARGET_TRACEBACK);
    expect(path).toBe('/tmp/neo-node-copyfile-fu2-20021/out2.txt');
    expect(path).not.toBe('/etc/hosts');
  });

  it('skips a copyfile line with no `-> <dst>` part instead of falling back to the source', () => {
    expect(
      sandboxDeniedWritePath("Error: EPERM: operation not permitted, copyfile '/tmp/neo-node-copyfile-fu2-20021/src.txt'"),
    ).toBeUndefined();
  });

  it('does not treat Python EACCES as a sandbox denial', () => {
    expect(
      sandboxDeniedWritePath("PermissionError: [Errno 13] Permission denied: '/System/x'"),
    ).toBeUndefined();
  });
});
