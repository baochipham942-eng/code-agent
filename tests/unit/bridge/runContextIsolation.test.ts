import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveCanonicalSandboxPath,
  resolveSandboxPath,
} from '../../../packages/bridge/src/security/sandbox';
import { bindBridgeRunToolContext } from '../../../packages/bridge/src/server';
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
