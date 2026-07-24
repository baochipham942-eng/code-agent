import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Bash's generated description is unrelated to cwd isolation and would otherwise
// try a model provider before falling back to the raw command in this unit test.
vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import {
  createRunContext,
  resolveCanonicalRunPath,
  type RunContext,
} from '../../../src/host/runtime/runContext';
import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { fileReadTracker } from '../../../src/host/tools/fileReadTracker';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { registerProtocolTool, unregisterProtocolTool } from '../../../src/host/tools/protocolToolRegistration';
import { ToolExecutor, type ExecuteOptions } from '../../../src/host/tools/toolExecutor';
import type { PermissionRequestData, ToolExecutionResult } from '../../../src/host/tools/types';
import type { ToolContext as ProtocolToolContext, ToolSchema } from '../../../src/host/protocol/tools';
import type { SwarmRunScope } from '../../../src/shared/contract/swarm';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';

const preApprovedRunTools = new Set(['Bash', 'Write']);

function executionOptions(context: RunContext): ExecuteOptions {
  return {
    runId: context.runId,
    sessionId: context.sessionId,
    preApprovedTools: preApprovedRunTools,
  };
}

function resultText(result: ToolExecutionResult): string {
  return String(result.output ?? result.result ?? '');
}

describe('ToolExecutor per-run workspace isolation', () => {
  let tempRoot: string;
  let permissionRequests: PermissionRequestData[];
  let baseExecutor: ToolExecutor;

  beforeAll(() => {
    // ToolExecutor resolves definitions through the protocol registry. Production
    // bootstrap performs this once; the test does it explicitly before real tool use.
    getProtocolRegistry();
  });

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-agent-run-isolation-'));
    permissionRequests = [];
    baseExecutor = new ToolExecutor({
      workingDirectory: tempRoot,
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return true;
      },
    });
    baseExecutor.setAuditEnabled(false);
    getToolCache().clear();
    getToolCache().resetStats();
    fileReadTracker.clear();
  });

  afterEach(async () => {
    getToolCache().clear();
    getToolCache().resetStats();
    fileReadTracker.clear();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('keeps identical relative Read, Bash, and Write calls isolated across concurrent runs', async () => {
    const repoA = path.join(tempRoot, 'repo-a');
    const repoB = path.join(tempRoot, 'repo-b');
    await Promise.all([
      fs.mkdir(repoA, { recursive: true }),
      fs.mkdir(repoB, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(repoA, 'marker.txt'), 'marker-from-a\n'),
      fs.writeFile(path.join(repoB, 'marker.txt'), 'marker-from-b\n'),
    ]);

    const runA = createRunContext({
      runId: 'run-workspace-a',
      sessionId: 'session-workspace-a',
      workspace: repoA,
    });
    const runB = createRunContext({
      runId: 'run-workspace-b',
      sessionId: 'session-workspace-b',
      workspace: repoB,
    });
    const executorA = baseExecutor.forRun(runA);
    const executorB = baseExecutor.forRun(runB);

    getToolCache().set('Read', { file_path: 'marker.txt' }, {
      toolCallId: 'cross-workspace-cache-poison',
      success: true,
      output: 'result-from-another-workspace',
    });

    const [readA, readB] = await Promise.all([
      executorA.execute('Read', { file_path: 'marker.txt' }, executionOptions(runA)),
      executorB.execute('Read', { file_path: 'marker.txt' }, executionOptions(runB)),
    ]);
    expect(readA).toMatchObject({ success: true });
    expect(readB).toMatchObject({ success: true });
    expect(resultText(readA)).toContain('marker-from-a');
    expect(resultText(readA)).not.toContain('marker-from-b');
    expect(resultText(readB)).toContain('marker-from-b');
    expect(resultText(readB)).not.toContain('marker-from-a');
    expect(resultText(readA)).not.toContain('result-from-another-workspace');
    expect(resultText(readB)).not.toContain('result-from-another-workspace');
    expect(getToolCache().getStats().hitCount).toBe(0);

    const bashScript =
      "process.stdout.write(process.cwd() + '|' + require('node:fs').readFileSync('marker.txt', 'utf8'))";
    const bashCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(bashScript)}`;
    const [bashA, bashB] = await Promise.all([
      executorA.execute(
        'Bash',
        { command: bashCommand, working_directory: '.' },
        executionOptions(runA),
      ),
      executorB.execute(
        'Bash',
        { command: bashCommand, working_directory: '.' },
        executionOptions(runB),
      ),
    ]);
    expect(bashA).toMatchObject({ success: true });
    expect(bashB).toMatchObject({ success: true });
    expect(resultText(bashA)).toContain(`${repoA}|marker-from-a`);
    expect(resultText(bashB)).toContain(`${repoB}|marker-from-b`);

    const [writeA, writeB] = await Promise.all([
      executorA.execute(
        'Write',
        { file_path: 'marker.txt', content: 'rewritten-by-a\n' },
        executionOptions(runA),
      ),
      executorB.execute(
        'Write',
        { file_path: 'marker.txt', content: 'rewritten-by-b\n' },
        executionOptions(runB),
      ),
    ]);
    expect(writeA).toMatchObject({ success: true });
    expect(writeB).toMatchObject({ success: true });
    await expect(fs.readFile(path.join(repoA, 'marker.txt'), 'utf8')).resolves.toBe('rewritten-by-a\n');
    await expect(fs.readFile(path.join(repoB, 'marker.txt'), 'utf8')).resolves.toBe('rewritten-by-b\n');

    const [readAfterWriteA, readAfterWriteB] = await Promise.all([
      executorA.execute('Read', { file_path: 'marker.txt' }, executionOptions(runA)),
      executorB.execute('Read', { file_path: 'marker.txt' }, executionOptions(runB)),
    ]);
    expect(resultText(readAfterWriteA)).toContain('rewritten-by-a');
    expect(resultText(readAfterWriteA)).not.toContain('rewritten-by-b');
    expect(resultText(readAfterWriteB)).toContain('rewritten-by-b');
    expect(resultText(readAfterWriteB)).not.toContain('rewritten-by-a');
  });

  it('allows Additional reads while fail-closing native writes to a read-only Source', async () => {
    const primary = path.join(tempRoot, 'primary');
    const docs = path.join(tempRoot, 'docs');
    await Promise.all([fs.mkdir(primary), fs.mkdir(docs)]);
    await fs.writeFile(path.join(docs, 'requirements.md'), 'read me\n');
    const workspaceScope = createWorkspaceScope('proj-multi', [
      { sourceId: 'primary', path: primary, role: 'primary', access: 'read_write' },
      { sourceId: 'docs', path: docs, role: 'additional', access: 'read_only' },
    ]);
    const run = createRunContext({
      runId: 'run-multi',
      sessionId: 'session-multi',
      workspace: primary,
      workspaceScope,
      cwd: docs,
    });
    const executor = baseExecutor.forRun(run);

    const read = await executor.execute(
      'Read',
      { file_path: path.join(docs, 'requirements.md') },
      executionOptions(run),
    );
    expect(read).toMatchObject({ success: true });
    expect(resultText(read)).toContain('read me');

    const write = await executor.execute(
      'Write',
      { file_path: path.join(docs, 'blocked.md'), content: 'blocked\n' },
      executionOptions(run),
    );
    expect(write).toMatchObject({
      success: false,
      metadata: expect.objectContaining({
        code: 'PROJECT_SOURCE_READ_ONLY',
        sourceId: 'docs',
        workspaceScopeVersion: workspaceScope.version,
      }),
    });
    await expect(fs.access(path.join(docs, 'blocked.md'))).rejects.toThrow();
  });

  it('uses cwd for relative targets while retaining workspace as the boundary', async () => {
    const workspace = path.join(tempRoot, 'nested-repo');
    const cwd = path.join(workspace, 'pkg');
    const sharedPath = path.join(workspace, 'shared.txt');
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(sharedPath, 'shared-before\n');

    const run = createRunContext({
      runId: 'run-nested-cwd',
      sessionId: 'session-nested-cwd',
      workspace,
      cwd,
    });
    const executor = baseExecutor.forRun(run);

    const read = await executor.execute(
      'Read',
      { file_path: '../shared.txt' },
      executionOptions(run),
    );
    expect(read).toMatchObject({ success: true });
    expect(resultText(read)).toContain('shared-before');

    const write = await executor.execute(
      'Write',
      { file_path: '../shared.txt', content: 'shared-after\n' },
      {
        runId: run.runId,
        sessionId: run.sessionId,
        // Force the normal permission request so the test can verify the
        // workspace-relative boundary classification for a cwd-relative path.
        skillToolBoundary: { skillName: 'run-isolation-test', allowedTools: [] },
      },
    );
    expect(write).toMatchObject({
      success: true,
      metadata: {
        writeIsolation: {
          kind: 'file',
          targetPath: resolveCanonicalRunPath(sharedPath),
          lockKey: `file:${resolveCanonicalRunPath(sharedPath)}`,
        },
      },
    });
    expect(permissionRequests.at(-1)).toMatchObject({
      type: 'file_write',
      details: { path: '../shared.txt' },
      boundary: { id: 'file.project_write' },
      sessionId: run.sessionId,
    });
    await expect(fs.readFile(sharedPath, 'utf8')).resolves.toBe('shared-after\n');
    await expect(fs.readFile(path.join(cwd, 'shared.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const bashAtWorkspace = await executor.execute(
      'Bash',
      { command: 'pwd', working_directory: '..' },
      executionOptions(run),
    );
    expect(bashAtWorkspace).toMatchObject({ success: true });
    const bashWorkspaceOutput = resultText(bashAtWorkspace);
    expect(bashWorkspaceOutput).toContain(`[cwd: ${run.workspace}]`);
    expect(bashWorkspaceOutput).toContain(await fs.realpath(workspace));

    const escapedBash = await executor.execute(
      'Bash',
      { command: 'pwd', working_directory: '../..' },
      executionOptions(run),
    );
    expect(escapedBash).toMatchObject({
      success: false,
      metadata: { code: 'RUN_WORKSPACE_BOUNDARY' },
    });
    expect(escapedBash.error).toContain('cannot execute outside workspace');

    expect(() => executor.setWorkingDirectory(tempRoot)).toThrow(
      'Run-scoped ToolExecutor workspace is immutable: run-nested-cwd',
    );
  });

  it('rejects a Bash cwd that escapes the workspace through a symlink', async () => {
    const workspace = path.join(tempRoot, 'symlink-repo');
    const outside = path.join(tempRoot, 'outside-repo');
    const link = path.join(workspace, 'outside-link');
    await Promise.all([
      fs.mkdir(workspace, { recursive: true }),
      fs.mkdir(outside, { recursive: true }),
    ]);
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    const run = createRunContext({
      runId: 'run-symlink-boundary',
      sessionId: 'session-symlink-boundary',
      workspace,
    });
    const executor = baseExecutor.forRun(run);

    const result = await executor.execute(
      'Bash',
      { command: 'pwd', working_directory: 'outside-link' },
      executionOptions(run),
    );

    expect(result).toMatchObject({
      success: false,
      metadata: { code: 'RUN_WORKSPACE_BOUNDARY' },
    });
    expect(result.error).toContain('cannot execute outside workspace');

    if (process.platform !== 'win32') {
      for (let index = 0; index <= 40; index += 1) {
        const target = index === 40 ? outside : `deep-link-${index + 1}`;
        await fs.symlink(target, path.join(workspace, `deep-link-${index}`));
      }
      const deepResult = await executor.execute(
        'Bash',
        { command: 'pwd', working_directory: 'deep-link-0' },
        executionOptions(run),
      );
      expect(deepResult).toMatchObject({
        success: false,
        metadata: { code: 'RUN_WORKSPACE_BOUNDARY' },
      });
    }
  });

  it('passes the immutable run context to the resolver and persists artifacts under workspace', async () => {
    const toolName = 'RunContextArtifactProbe';
    const schema: ToolSchema = {
      name: toolName,
      description: 'Emit a small base64 image for run context verification',
      inputSchema: { type: 'object', properties: {} },
      category: 'vision',
      permissionLevel: 'read',
      readOnly: true,
    };
    let observedContext: ProtocolToolContext | undefined;
    registerProtocolTool(schema, async () => ({
      schema,
      createHandler: () => ({
        schema,
        execute: async (_args, context) => {
          observedContext = context;
          return {
            ok: true as const,
            output: 'artifact-created',
            meta: {
              imageBase64: Buffer.alloc(64, 1).toString('base64'),
              mimeType: 'image/png',
            },
          };
        },
      }),
    }));

    try {
      const workspace = path.join(tempRoot, 'artifact-repo');
      const cwd = path.join(workspace, 'pkg');
      await fs.mkdir(cwd, { recursive: true });
      const run = createRunContext({
        runId: 'run-artifact-context',
        sessionId: 'session-artifact-context',
        workspace,
        cwd,
      });
      const executor = baseExecutor.forRun(run);

      const result = await executor.execute(toolName, {}, executionOptions(run));

      expect(result).toMatchObject({
        success: true,
        metadata: {
          imageBase64Persisted: true,
          artifact: {
            sessionId: run.sessionId,
          },
        },
      });
      expect(observedContext).toMatchObject({
        runId: run.runId,
        sessionId: run.sessionId,
        workspace: run.workspace,
        workingDir: run.cwd,
      });
      expect(result.outputPath).toContain(path.join(run.workspace, '.code-agent', 'artifacts', 'images'));
      expect((await fs.stat(result.outputPath!)).isFile()).toBe(true);
      expect(result.outputPath?.startsWith(run.cwd + path.sep)).toBe(false);
    } finally {
      unregisterProtocolTool(toolName);
    }
  });

  it('keeps Native Run identity separate from concurrent Agent Team child scopes', async () => {
    const toolName = 'RunIdentityProbe';
    const schema: ToolSchema = {
      name: toolName,
      description: 'Observe Native Run and Agent Team identities',
      inputSchema: { type: 'object', properties: {} },
      category: 'fs',
      permissionLevel: 'read',
      readOnly: true,
    };
    const observed: ProtocolToolContext[] = [];
    registerProtocolTool(schema, async () => ({
      schema,
      createHandler: () => ({
        schema,
        execute: async (_args, context) => {
          observed.push(context);
          return { ok: true as const, output: context.swarmRunScope?.runId };
        },
      }),
    }));

    try {
      const workspace = path.join(tempRoot, 'identity-repo');
      await fs.mkdir(workspace, { recursive: true });
      const nativeRun = createRunContext({
        runId: 'native-run-identity',
        sessionId: 'session-identity',
        workspace,
      });
      const executor = baseExecutor.forRun(nativeRun);
      const teamA: SwarmRunScope = {
        sessionId: nativeRun.sessionId,
        runId: 'team-run-a',
        treeId: 'team-tree-a',
        parentNativeRunId: nativeRun.runId,
      };
      const teamB: SwarmRunScope = {
        sessionId: nativeRun.sessionId,
        runId: 'team-run-b',
        treeId: 'team-tree-b',
        parentNativeRunId: nativeRun.runId,
      };

      await Promise.all([
        executor.execute(toolName, {}, { ...executionOptions(nativeRun), swarmRunScope: teamA }),
        executor.execute(toolName, {}, { ...executionOptions(nativeRun), swarmRunScope: teamB }),
      ]);

      expect(observed).toHaveLength(2);
      expect(observed.map((context) => context.runId)).toEqual([
        nativeRun.runId,
        nativeRun.runId,
      ]);
      expect(new Set(observed.map((context) => context.swarmRunScope?.runId))).toEqual(
        new Set([teamA.runId, teamB.runId]),
      );
      expect(observed.every((context) => context.sessionId === nativeRun.sessionId)).toBe(true);

      const mismatch = await executor.execute(toolName, {}, {
        ...executionOptions(nativeRun),
        swarmRunScope: { ...teamA, parentNativeRunId: 'different-native-run' },
      });
      expect(mismatch).toMatchObject({
        success: false,
        metadata: { code: 'RUN_CONTEXT_MISMATCH' },
      });
      expect(observed).toHaveLength(2);
    } finally {
      unregisterProtocolTool(toolName);
    }
  });
});
