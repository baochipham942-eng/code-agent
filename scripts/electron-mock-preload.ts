/**
 * Preload script to inject electron mock for CLI/test mode.
 * Usage: npx tsx --import ./scripts/electron-mock-preload.ts scripts/run-auto-tests.ts
 *
 * This patches Module.prototype.require so that any CJS `require('electron')`
 * returns the mock. For tsx (which transpiles ESM → CJS under the hood),
 * this intercepts all `import ... from 'electron'` calls.
 */

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const _require = createRequire(import.meta.url);
const Module = _require('module') as any;
const originalRequire = Module.prototype.require;

// Lazy-load the mock only when electron is first required
let electronMock: any = null;

Module.prototype.require = function(id: string, ...args: any[]) {
  if (id === 'electron') {
    if (!electronMock) {
      // Direct import of the mock module via require
      electronMock = _require(path.join(projectRoot, 'src/cli/electron-mock.ts'));
      // Handle both default export and named exports
      if (electronMock.default) {
        electronMock = electronMock.default;
      }
    }
    return electronMock;
  }
  return originalRequire.apply(this, [id, ...args]);
};
