import path from 'node:path';
import os from 'node:os';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  createRunContext,
  createRunHandle,
  resolveCanonicalRunPath,
} from '../../../../src/host/runtime/runContext';
import { RunRegistry, RunSessionConflictError } from '../../../../src/host/runtime/runRegistry';

describe('RunContext', () => {
  it('creates an immutable context with a run identity distinct from the session', () => {
    const context = createRunContext({
      sessionId: 'session-1',
      workspace: '/tmp/native-run-workspace',
      createdAt: 123,
    });

    expect(context.runId).not.toBe(context.sessionId);
    expect(context).toEqual({
      runId: expect.stringMatching(/^run-/),
      sessionId: 'session-1',
      workspace: resolveCanonicalRunPath('/tmp/native-run-workspace'),
      cwd: resolveCanonicalRunPath('/tmp/native-run-workspace'),
      createdAt: 123,
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Reflect.set(context, 'cwd', '/tmp/other-workspace')).toBe(false);
    expect(context.cwd).toBe(resolveCanonicalRunPath('/tmp/native-run-workspace'));
  });

  it('rejects an explicit runId that reuses the sessionId', () => {
    expect(() => createRunContext({
      runId: 'same-id',
      sessionId: 'same-id',
      workspace: '/tmp/native-run-workspace',
    })).toThrow('runId must be distinct from sessionId');
  });

  it('rejects a cwd outside the immutable workspace boundary', () => {
    expect(() => createRunContext({
      sessionId: 'session-1',
      workspace: '/tmp/native-run-workspace',
      cwd: '/tmp/other-workspace',
    })).toThrow('Run cwd must stay inside workspace');
  });

  it('freezes the canonical workspace target when a symlink is retargeted', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'code-agent-run-context-'));
    const targetA = path.join(tempRoot, 'repo-a');
    const targetB = path.join(tempRoot, 'repo-b');
    const workspaceLink = path.join(tempRoot, 'workspace');
    mkdirSync(targetA);
    mkdirSync(targetB);
    symlinkSync(targetA, workspaceLink, process.platform === 'win32' ? 'junction' : 'dir');

    try {
      const context = createRunContext({
        runId: 'run-canonical-workspace',
        sessionId: 'session-canonical-workspace',
        workspace: workspaceLink,
      });

      unlinkSync(workspaceLink);
      symlinkSync(targetB, workspaceLink, process.platform === 'win32' ? 'junction' : 'dir');

      expect(context.workspace).toBe(resolveCanonicalRunPath(targetA));
      expect(context.cwd).toBe(resolveCanonicalRunPath(targetA));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('RunHandle', () => {
  it('remembers cancellation before attach and delivers it exactly once to the target', async () => {
    const handle = createRunHandle(createRunContext({
      runId: 'run-1',
      sessionId: 'session-1',
      workspace: '/tmp/native-run-workspace',
    }));
    const cancel = vi.fn();
    const target = { cancel };

    await handle.cancel('session-switch');

    expect(handle.cancellationRequested).toBe(true);
    expect(handle.isAttached).toBe(false);
    expect(cancel).not.toHaveBeenCalled();

    await handle.attach(target);
    await handle.cancel('user');
    await handle.attach(target);

    expect(handle.isAttached).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('session-switch');
  });

  it('fails closed for controls after cancellation has been requested', async () => {
    const handle = createRunHandle(createRunContext({
      runId: 'run-cancelled-controls',
      sessionId: 'session-cancelled-controls',
      workspace: '/tmp/native-run-workspace',
    }));
    const target = {
      cancel: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      steer: vi.fn(),
    };
    await handle.attach(target);
    await handle.cancel('user');

    await expect(handle.pause()).rejects.toThrow('cannot pause after cancellation');
    await expect(handle.resume()).rejects.toThrow('cannot resume after cancellation');
    await expect(handle.steer('late message')).rejects.toThrow('cannot steer after cancellation');
    expect(target.pause).not.toHaveBeenCalled();
    expect(target.resume).not.toHaveBeenCalled();
    expect(target.steer).not.toHaveBeenCalled();
  });
});

describe('RunRegistry', () => {
  it('fails closed when a session tries to start a second active run', () => {
    const registry = new RunRegistry();
    registry.start({
      runId: 'run-1',
      sessionId: 'session-1',
      workspace: '/tmp/native-run-workspace',
    });

    expect(() => registry.start({
      runId: 'run-2',
      sessionId: 'session-1',
      workspace: '/tmp/native-run-workspace',
    })).toThrowError(RunSessionConflictError);
    expect(registry.getBySessionId('session-1')?.context.runId).toBe('run-1');
    expect(registry.size).toBe(1);
  });

  it('does not let a stale expected handle unregister a replacement run', () => {
    const registry = new RunRegistry();
    const staleHandle = registry.start({
      runId: 'run-reused',
      sessionId: 'session-1',
      workspace: '/tmp/native-run-workspace',
    });
    expect(registry.unregister('run-reused', staleHandle)).toBe(true);

    const replacementHandle = registry.start({
      runId: 'run-reused',
      sessionId: 'session-1',
      workspace: '/tmp/native-run-workspace',
    });

    expect(registry.unregister('run-reused', staleHandle)).toBe(false);
    expect(registry.get('run-reused')).toBe(replacementHandle);
    expect(registry.getBySessionId('session-1')).toBe(replacementHandle);
    expect(registry.size).toBe(1);
  });
});
