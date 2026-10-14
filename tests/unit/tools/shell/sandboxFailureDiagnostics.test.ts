import { describe, expect, it } from 'vitest';
import {
  sandboxDeniedWritePath,
  sandboxDeniedWriteCreatesDirectory,
} from '../../../../src/host/tools/shell/sandboxFailureDiagnostics';

// Captured from: python3 -c "open('/System/x','w')" 2>&1
const PYTHON_OPEN_TRACEBACK = `Traceback (most recent call last):
  File "<string>", line 1, in <module>
    open('/System/x','w')
    ~~~~^^^^^^^^^^^^^^^^^
PermissionError: [Errno 1] Operation not permitted: '/System/x'`;

// Captured from: node -e "require('node:fs').writeFileSync('/System/x','x')" 2>&1
const NODE_WRITE_TRACEBACK = `node:fs:2482
    return binding.writeFileUtf8(
                   ^

Error: EPERM: operation not permitted, open '/System/x'
    at Object.writeFileSync (node:fs:2482:20)
    at [eval]:1:20
    at runScriptInThisContext (node:internal/vm:219:10)
    at node:internal/process/execution:451:12
    at [eval]-wrapper:6:24
    at runScriptInContext (node:internal/process/execution:447:60)
    at evalFunction (node:internal/process/execution:87:30)
    at evalScript (node:internal/process/execution:99:3) {
  errno: -1,
  code: 'EPERM',
  syscall: 'open',
  path: '/System/x'
}

Node.js v24.21.0`;

describe('sandboxDeniedWritePath', () => {
  it('recognises a Python PermissionError write traceback', () => {
    expect(sandboxDeniedWritePath(PYTHON_OPEN_TRACEBACK)).toBe('/System/x');
    expect(sandboxDeniedWriteCreatesDirectory(PYTHON_OPEN_TRACEBACK)).toBe(false);
  });

  it('recognises a Node fs.writeFileSync EPERM traceback', () => {
    expect(sandboxDeniedWritePath(NODE_WRITE_TRACEBACK)).toBe('/System/x');
  });

  it('does not treat Python EACCES as a sandbox denial', () => {
    expect(
      sandboxDeniedWritePath("PermissionError: [Errno 13] Permission denied: '/System/x'"),
    ).toBeUndefined();
  });
});
