import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NATIVE_RECOVERY_SCHEMA_VERSION, type NativeRecoveryDescriptor } from '../../../../src/host/runtime/nativeRecoveryHost';
import { resolveAdoptedRecoveryWorkspace } from '../../../../src/host/runtime/adoptedRecoveryWorkspace';
import { createWorkspaceScope } from '../../../../src/host/runtime/workspaceScope';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function descriptor(root: string): NativeRecoveryDescriptor {
  return {
    schemaVersion: NATIVE_RECOVERY_SCHEMA_VERSION,
    kind: 'native',
    sourceMessageId: 'message-1',
    provider: 'custom-tokenrhythm',
    model: 'deepseek-v4-flash',
    workspace: {
      root,
      cwd: root,
      fingerprint: 'fingerprint',
      scope: createWorkspaceScope('project-quota', [{
        sourceId: 'source-primary',
        path: root,
        role: 'primary',
        access: 'read_write',
      }]),
    },
    logicalOperationId: 'op-logical',
    operationId: 'op-1',
    phase: 'before_model_dispatch',
    checkpointSequence: 1,
  };
}

describe('resolveAdoptedRecoveryWorkspace', () => {
  it('keeps a caller cwd inside the parked Project Sources', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'quota-adopt-inside-'));
    roots.push(root);
    const inside = path.join(root, 'nested');
    mkdirSync(inside);
    const adopted = resolveAdoptedRecoveryWorkspace({
      workspace: root,
      cwd: inside,
      workspaceScope: descriptor(root).workspace.scope,
    }, descriptor(root));
    expect(adopted?.cwd).toBe(inside);
    expect(adopted?.workspace).toBe(root);
  });

  it('uses the parked workspace when the caller cwd is the default home directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'quota-adopt-home-'));
    roots.push(root);
    const adopted = resolveAdoptedRecoveryWorkspace({
      workspace: homedir(),
      cwd: homedir(),
    }, descriptor(root));
    expect(adopted?.cwd).toBe(root);
    expect(adopted?.workspace).toBe(root);
    expect(adopted?.workspaceScope?.primaryRoot).toBe(realpathSync(root));
  });
});
