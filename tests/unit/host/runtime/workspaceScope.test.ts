import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WorkspaceScopeResolver,
  canonicalizeWorkspacePath,
  createWorkspaceScope,
} from '../../../../src/host/runtime/workspaceScope';
import { createRunContext } from '../../../../src/host/runtime/runContext';

// macOS /tmp and /var are symlinks (/private/tmp, /private/var). Linux CI has no
// such alias — skip rather than fail the premise.
const TMP_HAS_ALIAS = realpathSync.native(os.tmpdir()) !== path.resolve(os.tmpdir());

function rootsFixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'neo-multi-source-'));
  const primary = path.join(base, 'primary');
  const readonly = path.join(base, 'docs');
  const writable = path.join(base, 'tools');
  mkdirSync(primary);
  mkdirSync(readonly);
  mkdirSync(writable);
  return { base, primary, readonly, writable };
}

describe('WorkspaceScopeResolver', () => {
  it('resolves Primary and Additional permissions with a stable snapshot', () => {
    const fixture = rootsFixture();
    const scope = createWorkspaceScope('proj_a', [
      { sourceId: 'primary', path: fixture.primary, role: 'primary', access: 'read_write' },
      { sourceId: 'docs', path: fixture.readonly, role: 'additional', access: 'read_only' },
      { sourceId: 'tools', path: fixture.writable, role: 'additional', access: 'read_write' },
    ]);
    const resolver = new WorkspaceScopeResolver(scope);
    expect(resolver.canRead(path.join(fixture.readonly, 'requirements.md'))).toBe(true);
    expect(resolver.canWrite(path.join(fixture.readonly, 'requirements.md'))).toBe(false);
    expect(resolver.canWrite(path.join(fixture.writable, 'script.ts'))).toBe(true);
    expect(resolver.canRead(path.join(fixture.base, 'external.txt'))).toBe(false);
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.roots)).toBe(true);
  });

  it('rejects duplicate, nested and multiple Primary roots', () => {
    const fixture = rootsFixture();
    expect(() => createWorkspaceScope('proj_a', [
      { sourceId: 'a', path: fixture.primary, role: 'primary', access: 'read_write' },
      { sourceId: 'b', path: fixture.primary, role: 'additional', access: 'read_only' },
    ])).toThrow(/duplicate|overlap/i);
    expect(() => createWorkspaceScope('proj_a', [
      { sourceId: 'a', path: fixture.base, role: 'primary', access: 'read_write' },
      { sourceId: 'b', path: fixture.primary, role: 'additional', access: 'read_only' },
    ])).toThrow(/overlap/i);
    expect(() => createWorkspaceScope('proj_a', [
      { sourceId: 'a', path: fixture.primary, role: 'primary', access: 'read_write' },
      { sourceId: 'b', path: fixture.readonly, role: 'primary', access: 'read_write' },
    ])).toThrow(/exactly one/i);
  });

  it('canonicalizes symlinks and rejects a cwd outside all roots', () => {
    const fixture = rootsFixture();
    const link = path.join(fixture.base, 'primary-link');
    symlinkSync(fixture.primary, link);
    expect(canonicalizeWorkspacePath(link)).toBe(canonicalizeWorkspacePath(fixture.primary));
    const scope = createWorkspaceScope('proj_a', [
      { sourceId: 'primary', path: link, role: 'primary', access: 'read_write' },
      { sourceId: 'docs', path: fixture.readonly, role: 'additional', access: 'read_only' },
    ]);
    expect(createRunContext({
      runId: 'run-a',
      sessionId: 'session-a',
      workspace: link,
      workspaceScope: scope,
      cwd: fixture.readonly,
      createdAt: 1,
    }).cwd).toBe(canonicalizeWorkspacePath(fixture.readonly));
    expect(() => createRunContext({
      runId: 'run-b',
      sessionId: 'session-a',
      workspace: link,
      workspaceScope: scope,
      cwd: fixture.base,
      createdAt: 1,
    })).toThrow(/workspace Project Sources/);
  });

  it.skipIf(!TMP_HAS_ALIAS)('canonicalizes a tmp alias and a nonexistent leaf onto the native ancestor', () => {
    const lexical = mkdtempSync(path.join(os.tmpdir(), 'ws-alias-'));
    try {
      const canonical = realpathSync.native(lexical);
      expect(path.resolve(lexical)).not.toBe(canonical);
      expect(canonicalizeWorkspacePath(lexical)).toBe(canonical);

      const missing = path.join(lexical, 'not-created');
      expect(existsSync(missing)).toBe(false);
      expect(canonicalizeWorkspacePath(missing)).toBe(path.join(canonical, 'not-created'));

      // Symlink walk already rewrites /var → /private/var. The ENOENT fallback's
      // realpathSync.native is what still pins the existing ancestor's on-disk spelling.
      mkdirSync(path.join(lexical, 'CamelDir'));
      const casedLeaf = path.join(lexical, 'cameldir', 'not-created');
      expect(existsSync(casedLeaf)).toBe(false);
      expect(realpathSync.native(path.join(lexical, 'cameldir'))).toBe(path.join(canonical, 'CamelDir'));
      expect(canonicalizeWorkspacePath(casedLeaf)).toBe(path.join(canonical, 'CamelDir', 'not-created'));
    } finally {
      rmSync(lexical, { recursive: true, force: true });
    }
  });
});
