import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveCanonicalSandboxPath,
  resolveSandboxPath,
} from '../../../packages/bridge/src/security/sandbox';
import {
  BridgeRunContextBindings,
  bindBridgeRunToolContext,
} from '../../../packages/bridge/src/server';
import { fileGrepTool } from '../../../packages/bridge/src/tools/fileGrep';
import { fileWriteTool } from '../../../packages/bridge/src/tools/fileWrite';
import { shellExecTool } from '../../../packages/bridge/src/tools/shellExec';
import type { BridgeConfig, ToolContext } from '../../../packages/bridge/src/types';

function config(workspace: string): BridgeConfig {
  return {
    port: 0,
    workingDirectories: [workspace],
    securityLevel: 'normal',
    commandWhitelist: [],
    commandBlacklist: [],
    autoConfirmL2: true,
    shellTimeout: 60_000,
  };
}

function context(
  runId: string,
  sessionId: string,
  workspace: string,
  cwd = workspace,
  abortSignal?: AbortSignal,
): ToolContext {
  return {
    config: config(workspace),
    runId,
    sessionId,
    workspace,
    cwd,
    abortSignal,
    wsBroadcast: vi.fn(),
  };
}

describe('Bridge run context isolation', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-run-context-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('writes identical relative paths into each run cwd', async () => {
    const repoA = path.join(tempRoot, 'repo-a');
    const repoB = path.join(tempRoot, 'repo-b');
    await Promise.all([fs.mkdir(repoA), fs.mkdir(repoB)]);

    await Promise.all([
      fileWriteTool.run(
        { path: 'same.txt', content: 'from-a', cwd: repoA },
        context('run-a', 'session-a', repoA),
      ),
      fileWriteTool.run(
        { path: 'same.txt', content: 'from-b', cwd: repoB },
        context('run-b', 'session-b', repoB),
      ),
    ]);

    await expect(fs.readFile(path.join(repoA, 'same.txt'), 'utf8')).resolves.toBe('from-a');
    await expect(fs.readFile(path.join(repoB, 'same.txt'), 'utf8')).resolves.toBe('from-b');
  });

  it('binds complete Run requests, rejects partial context, and keeps legacy identities distinct', async () => {
    const workspace = path.join(tempRoot, 'bound-repo');
    const cwd = path.join(workspace, 'package');
    await fs.mkdir(cwd, { recursive: true });
    const bridgeConfig = config(tempRoot);
    const signal = new AbortController().signal;
    const wsBroadcast = vi.fn();

    const bound = await bindBridgeRunToolContext({
      tool: 'file_read',
      params: { path: 'input.txt' },
      requestId: 'request-run',
      runId: 'run-request',
      sessionId: 'session-request',
      workspace,
      cwd,
    }, bridgeConfig, wsBroadcast, signal);
    expect(bound.context).toMatchObject({
      runId: 'run-request',
      sessionId: 'session-request',
      workspace: resolveCanonicalSandboxPath(workspace),
      cwd: resolveCanonicalSandboxPath(cwd),
      config: { workingDirectories: [resolveCanonicalSandboxPath(workspace)] },
    });
    expect(bound.params.cwd).toBe(resolveCanonicalSandboxPath(cwd));

    await expect(bindBridgeRunToolContext({
      tool: 'file_read',
      params: {},
      requestId: 'request-partial',
      runId: 'run-partial',
    }, bridgeConfig, wsBroadcast, signal)).rejects.toThrow(
      'Bridge run context must include runId, sessionId, workspace, and cwd together',
    );

    const missingLegacyWorkspace = path.join(tempRoot, 'moved-away-workspace');
    const legacyConfig = config(missingLegacyWorkspace);
    const legacy = await bindBridgeRunToolContext({
      tool: 'file_read',
      params: { marker: 'preserved' },
      requestId: 'request-legacy',
    }, legacyConfig, wsBroadcast, signal);
    expect(legacy.context.runId).toBe('legacy-run-request-legacy');
    expect(legacy.context.sessionId).toBe('legacy-session-request-legacy');
    expect(legacy.context.runId).not.toBe(legacy.context.sessionId);
    expect(legacy.context.config).toBe(legacyConfig);
    expect(legacy.context.workspace).toBe(path.resolve(missingLegacyWorkspace));
    expect(legacy.params).toEqual({ marker: 'preserved' });
  });

  it('rejects session, workspace, and cwd changes after a run is bound', async () => {
    const workspaceA = path.join(tempRoot, 'repo-a');
    const cwdA = path.join(workspaceA, 'package-a');
    const cwdB = path.join(workspaceA, 'package-b');
    const workspaceB = path.join(tempRoot, 'repo-b');
    await Promise.all([
      fs.mkdir(cwdA, { recursive: true }),
      fs.mkdir(cwdB, { recursive: true }),
      fs.mkdir(workspaceB),
    ]);
    const bindings = new BridgeRunContextBindings({ ttlMs: 60_000, maxEntries: 16 });
    const bridgeConfig = config(tempRoot);
    const signal = new AbortController().signal;
    const wsBroadcast = vi.fn();
    const request = {
      tool: 'file_read',
      params: { path: 'input.txt' },
      requestId: 'request-first',
      runId: 'run-pinned',
      sessionId: 'session-a',
      workspace: workspaceA,
      cwd: cwdA,
    };

    await bindBridgeRunToolContext(request, bridgeConfig, wsBroadcast, signal, bindings);

    await expect(bindBridgeRunToolContext({
      ...request,
      requestId: 'request-session-change',
      sessionId: 'session-b',
    }, bridgeConfig, wsBroadcast, signal, bindings)).rejects.toThrow('sessionId');
    await expect(bindBridgeRunToolContext({
      ...request,
      requestId: 'request-workspace-change',
      workspace: workspaceB,
      cwd: workspaceB,
    }, bridgeConfig, wsBroadcast, signal, bindings)).rejects.toThrow('workspace');
    await expect(bindBridgeRunToolContext({
      ...request,
      requestId: 'request-cwd-change',
      cwd: cwdB,
    }, bridgeConfig, wsBroadcast, signal, bindings)).rejects.toThrow('cwd');
  });

  it('keeps different runs isolated when their first requests arrive concurrently', async () => {
    const workspaceA = path.join(tempRoot, 'concurrent-a');
    const workspaceB = path.join(tempRoot, 'concurrent-b');
    await Promise.all([fs.mkdir(workspaceA), fs.mkdir(workspaceB)]);
    const bindings = new BridgeRunContextBindings({ ttlMs: 60_000, maxEntries: 16 });
    const bridgeConfig = config(tempRoot);
    const signal = new AbortController().signal;
    const wsBroadcast = vi.fn();

    const [runA, runB] = await Promise.all([
      bindBridgeRunToolContext({
        tool: 'file_read',
        params: {},
        requestId: 'request-a',
        runId: 'run-a',
        sessionId: 'session-a',
        workspace: workspaceA,
        cwd: workspaceA,
      }, bridgeConfig, wsBroadcast, signal, bindings),
      bindBridgeRunToolContext({
        tool: 'file_read',
        params: {},
        requestId: 'request-b',
        runId: 'run-b',
        sessionId: 'session-b',
        workspace: workspaceB,
        cwd: workspaceB,
      }, bridgeConfig, wsBroadcast, signal, bindings),
    ]);

    expect(runA.context.workspace).toBe(resolveCanonicalSandboxPath(workspaceA));
    expect(runB.context.workspace).toBe(resolveCanonicalSandboxPath(workspaceB));
    expect(bindings.size).toBe(2);
  });

  it('binds Bridge trace metadata to the exact target run and rejects mismatches', async () => {
    const workspace = path.join(tempRoot, 'trace-bound');
    await fs.mkdir(workspace);
    const request = {
      tool: 'file_read', params: {}, requestId: 'request-trace',
      runId: 'run-trace', sessionId: 'session-trace', workspace, cwd: workspace,
      traceContext: {
        traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1,
        traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`,
        runId: 'run-trace', sessionId: 'session-trace', attempt: 1, ownerEpoch: 1,
        engine: 'native', workspaceFingerprint: 'workspace-fingerprint', processInstanceId: 'process-1',
      },
    };
    const bound = await bindBridgeRunToolContext(
      request,
      config(tempRoot),
      vi.fn(),
      new AbortController().signal,
    );
    expect(bound.context.traceContext).toEqual(request.traceContext);

    await expect(bindBridgeRunToolContext({
      ...request,
      traceContext: { ...request.traceContext, runId: 'run-other' },
    }, config(tempRoot), vi.fn(), new AbortController().signal)).rejects.toThrow(/target run/);
  });

  it('reclaims expired and least-recently-used run bindings safely', async () => {
    const workspaceA = path.join(tempRoot, 'lease-a');
    const workspaceB = path.join(tempRoot, 'lease-b');
    const workspaceC = path.join(tempRoot, 'lease-c');
    await Promise.all([fs.mkdir(workspaceA), fs.mkdir(workspaceB), fs.mkdir(workspaceC)]);
    let now = 1_000;
    const bindings = new BridgeRunContextBindings({
      ttlMs: 1_000,
      maxEntries: 2,
      now: () => now,
    });
    const bridgeConfig = config(tempRoot);
    const signal = new AbortController().signal;
    const wsBroadcast = vi.fn();
    const bind = (runId: string, sessionId: string, workspace: string) => bindBridgeRunToolContext({
      tool: 'file_read',
      params: {},
      requestId: `request-${runId}-${sessionId}`,
      runId,
      sessionId,
      workspace,
      cwd: workspace,
    }, bridgeConfig, wsBroadcast, signal, bindings);

    await bind('run-expiring', 'session-a', workspaceA);
    now += 1_001;
    const rebound = await bind('run-expiring', 'session-b', workspaceB);
    expect(rebound.context).toMatchObject({
      runId: 'run-expiring',
      sessionId: 'session-b',
      workspace: resolveCanonicalSandboxPath(workspaceB),
    });

    await bind('run-second', 'session-second', workspaceB);
    await bind('run-third', 'session-third', workspaceC);
    expect(bindings.size).toBe(2);
    const reboundAfterEviction = await bind('run-expiring', 'session-after-eviction', workspaceA);
    expect(reboundAfterEviction.context).toMatchObject({
      sessionId: 'session-after-eviction',
      workspace: resolveCanonicalSandboxPath(workspaceA),
    });
    expect(bindings.size).toBe(2);
  });

  it('rejects ordinary symlink escapes and a chain deeper than forty links', async () => {
    const workspace = path.join(tempRoot, 'repo');
    const outside = path.join(tempRoot, 'outside');
    await Promise.all([fs.mkdir(workspace), fs.mkdir(outside)]);
    await fs.symlink(outside, path.join(workspace, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => resolveSandboxPath('outside-link/file.txt', [workspace], workspace))
      .toThrow('Path is outside sandbox');

    const target = path.join(workspace, 'target');
    await fs.writeFile(target, 'target');
    for (let index = 41; index >= 0; index -= 1) {
      const next = index === 41 ? target : path.join(workspace, `link-${index + 1}`);
      await fs.symlink(next, path.join(workspace, `link-${index}`), 'file');
    }
    expect(() => resolveCanonicalSandboxPath(path.join(workspace, 'link-0')))
      .toThrow('Too many symbolic links');
  });

  it('does not read a symlink file returned by glob when it points outside workspace', async () => {
    const workspace = path.join(tempRoot, 'grep-repo');
    const outside = path.join(tempRoot, 'outside-secret.txt');
    await fs.mkdir(workspace);
    await fs.writeFile(outside, 'OUTSIDE_ONLY_PAYLOAD');
    await fs.symlink(outside, path.join(workspace, 'linked-secret.txt'), 'file');

    const output = await fileGrepTool.run(
      { pattern: 'OUTSIDE_ONLY', include: '**/*.txt', cwd: workspace },
      context('run-grep', 'session-grep', workspace),
    );

    expect(JSON.parse(output)).toMatchObject({ matchCount: 0, results: [] });
    expect(output).not.toContain('PAYLOAD');
  });

  it('kills the target Bridge shell process tree when the request is aborted', async () => {
    const workspace = path.join(tempRoot, 'shell-repo');
    await fs.mkdir(workspace);
    const childPidPath = path.join(workspace, 'child.pid');
    const survivedPath = path.join(workspace, 'child-survived.txt');
    const childScript = [
      "const fs = require('node:fs')",
      `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid))`,
      `setTimeout(() => fs.writeFileSync(${JSON.stringify(survivedPath)}, 'leaked'), 750)`,
      'setTimeout(() => {}, 30_000)',
    ].join(';');
    const command = process.platform === 'win32'
      ? `& ${JSON.stringify(process.execPath)} -e ${JSON.stringify(childScript)}`
      : `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childScript)} & wait`;
    const abortController = new AbortController();
    const shellContext = context(
      'run-shell',
      'session-shell',
      workspace,
      workspace,
      abortController.signal,
    );
    shellContext.config.securityLevel = 'relaxed';
    const invocation = shellExecTool.run(
      { command, cwd: workspace },
      shellContext,
    );
    const cancellationResult = invocation.then(
      () => null,
      (error: unknown) => error,
    );

    let childPid: number | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        childPid = Number(await fs.readFile(childPidPath, 'utf8'));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(childPid).toBeTypeOf('number');
    abortController.abort();
    expect(await cancellationResult).toMatchObject({ message: 'Command cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await expect(fs.readFile(survivedPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => process.kill(childPid!, 0)).toThrow();
  });
});
