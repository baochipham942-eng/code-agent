#!/usr/bin/env npx tsx

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const ROLE_ID = 'hs1-codex-live-smoke';
const FILES = ['hs1-smoke-a.txt', 'hs1-smoke-b.txt', 'hs1-smoke-c.txt'] as const;

async function main(): Promise<void> {
  const repoPath = process.cwd();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-hs1-live-smoke-'));
  process.env.CODE_AGENT_DATA_DIR = dataDir;
  process.env.CODE_AGENT_WORKING_DIR = repoPath;

  const agentsDir = path.join(dataDir, 'agents');
  await fs.mkdir(agentsDir, { recursive: true });
  await fs.writeFile(path.join(agentsDir, `${ROLE_ID}.md`), [
    '---',
    `name: ${ROLE_ID}`,
    'description: HS1 Codex live smoke role',
    'engine: codex_cli',
    'tools:',
    '  - Read',
    'model: balanced',
    'max-iterations: 5',
    '---',
    'Follow the task exactly and finish after the requested files exist.',
  ].join('\n'), 'utf8');

  const [{ initAgentRegistry, disposeAgentRegistry }, { executeSpawnAgent }, { AppWindow }] = await Promise.all([
    import('../../src/host/agent/agentRegistry'),
    import('../../src/host/agent/multiagentTools/spawnAgent'),
    import('../../src/host/platform'),
  ]);
  const originalGetAllWindows = AppWindow.getAllWindows;
  let windowBroadcastEnumerationCount = 0;
  Object.defineProperty(AppWindow, 'getAllWindows', {
    configurable: true,
    value: () => {
      windowBroadcastEnumerationCount += 1;
      return [];
    },
  });

  await initAgentRegistry(repoPath);
  try {
    const emittedEvents: Array<{ event: string; data: unknown }> = [];
    const result = await executeSpawnAgent({
      role: ROLE_ID,
      task: '在工作目录新建 hs1-smoke-a.txt、hs1-smoke-b.txt、hs1-smoke-c.txt，每个文件各写一行，内容分别为 alpha、beta、gamma。不要改其他文件。',
      waitForCompletion: true,
    }, {
      sessionId: `hs1-live-smoke-${Date.now()}`,
      cwd: repoPath,
      workspace: repoPath,
      modelConfig: { provider: 'openai', model: 'gpt-5.3-codex' },
      resolver: { getDefinition: () => undefined },
      permission: { request: async () => false },
      events: { emit: (event, data) => emittedEvents.push({ event, data }) },
      abortSignal: new AbortController().signal,
    });

    const output = result.output ?? result.error ?? '';
    const worktreePath = /Worktree: preserved at ([^\s]+) \(branch:/.exec(output)?.[1];
    if (!result.success || !worktreePath) {
      throw new Error(`spawn_agent live smoke failed: ${JSON.stringify(result)}`);
    }

    const files = await Promise.all(FILES.map(async (filename) => ({
      filename,
      content: (await fs.readFile(path.join(worktreePath, filename), 'utf8')).trim(),
    })));
    const expected = ['alpha', 'beta', 'gamma'];
    if (files.some((file, index) => file.content !== expected[index])) {
      throw new Error(`unexpected worktree contents: ${JSON.stringify(files)}`);
    }

    const engineLogDir = path.join(dataDir, 'logs', 'agent-engines', 'codex-cli');
    const engineLogs = await fs.readdir(engineLogDir);
    const runLog = engineLogs.find((name) => name.endsWith('.log'));
    const stdoutSummary = runLog
      ? summarizeCodexLog(await fs.readFile(path.join(engineLogDir, runLog), 'utf8'))
      : [];
    const hostLogPath = path.join(dataDir, 'logs', `code-agent-${new Date().toISOString().slice(0, 10)}.log`);
    const hostLog = await fs.readFile(hostLogPath, 'utf8');
    const hostLines = hostLog.split(/\r?\n/);
    const selectionLine = hostLines.findIndex((line) => line.includes('external subagent engine selected'));
    const hostSelectionSummary = selectionLine >= 0
      ? hostLines.slice(selectionLine, selectionLine + 7).join('\n')
      : '';

    console.log(JSON.stringify({
      ok: true,
      roleId: ROLE_ID,
      engine: 'codex_cli',
      profile: 'workspace_write',
      worktreePath,
      files,
      windowBroadcastEnumerationCount,
      subagentContextEventCount: emittedEvents.length,
      hostSelectionSummary,
      codexStdoutSummary: stdoutSummary,
      spawnOutput: output,
      dataDir,
    }, null, 2));
  } finally {
    Object.defineProperty(AppWindow, 'getAllWindows', {
      configurable: true,
      value: originalGetAllWindows,
    });
    await disposeAgentRegistry();
  }
}

function summarizeCodexLog(log: string): unknown[] {
  const summary: unknown[] = [];
  for (const line of log.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        usage?: unknown;
        item?: { type?: string; text?: string; aggregated_output?: string; changes?: Array<{ path?: string; kind?: string }> };
      };
      if (event.type === 'turn.completed') {
        summary.push({ type: event.type, usage: event.usage });
      } else if (event.item?.type === 'file_change') {
        summary.push({
          type: event.type,
          item: {
            type: event.item.type,
            changes: event.item.changes?.map((change) => ({
              path: change.path ? path.basename(change.path) : undefined,
              kind: change.kind,
            })),
          },
        });
      } else if (event.item?.type === 'agent_message') {
        summary.push({ type: event.type, item: { type: event.item.type, text: event.item.text } });
      } else if (event.item?.type === 'command_execution' && event.item.aggregated_output) {
        summary.push({ type: event.type, item: { type: event.item.type, output: event.item.aggregated_output } });
      }
    } catch {
      // Ignore non-JSON diagnostic lines; the adapter already records them in the raw run log.
    }
  }
  return summary.slice(-6);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
