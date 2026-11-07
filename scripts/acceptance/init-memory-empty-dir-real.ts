#!/usr/bin/env npx tsx
// N-INIT-PROJECT-MEMORY-REST2：glm-5.3 真实回放 /init-memory 对空目录 / 仅 .git 目录。
// 用法：set -a; source ~/.code-agent/.env; set +a
//       CODE_AGENT_DATA_DIR=$(mktemp -d) npx tsx scripts/acceptance/init-memory-empty-dir-real.ts <fixtureDir> [rounds]
// 工具：真实 ListDirectory / Read / ProposeProjectMemory handler；ToolSearch 为脚本内桩（只负责「加载」ProposeProjectMemory）。
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import type { ToolContext, ToolModule } from '../../src/host/protocol/tools';
import { ZHIPU_CODING_TIER } from './_jev-real-sites-lib';

const TEMPERATURE = 0;
const MAX_OUTPUT_TOKENS = 4096;
const CALL_TIMEOUT_MS = 180_000;
const MAX_STEPS = 12;

interface ToolCall { id?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface WireSchema { name: string; description: string; inputSchema: unknown }

const toolSearchSchema: WireSchema = {
  name: 'ToolSearch',
  description: 'Load deferred tools. Query form: select:<tool_name>[,<tool_name>...]',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

async function main(): Promise<void> {
  const [fixture, roundsArg] = process.argv.slice(2);
  const apiKey = (process.env.ZHIPU_CODING_API_KEY ?? '').trim();
  if (!fixture) throw new Error('usage: init-memory-empty-dir-real.ts <fixtureDir> [rounds]');
  if (!apiKey) throw new Error('ZHIPU_CODING_API_KEY is required; refusing to skip the real-model run');
  if (!process.env.CODE_AGENT_DATA_DIR) throw new Error('CODE_AGENT_DATA_DIR must be set to an isolated dir');
  const rounds = Number(roundsArg ?? 3);

  const { BUILTIN_PROMPT_COMMANDS } = await import('../../src/shared/commands/builtinPromptCommands');
  const { listDirectoryModule } = await import('../../src/host/tools/modules/file/listDirectory');
  const { readModule } = await import('../../src/host/tools/modules/file/read');
  const { proposeProjectMemoryModule } = await import('../../src/host/tools/modules/lightMemory/proposeProjectMemory');
  const template = BUILTIN_PROMPT_COMMANDS.find((c) => c.name === 'init-memory')?.template;
  if (!template) throw new Error('init-memory template not found');

  const modules: Record<string, ToolModule<Record<string, unknown>, string>> = {
    ListDirectory: listDirectoryModule,
    Read: readModule,
    ProposeProjectMemory: proposeProjectMemoryModule,
  };
  const wire = (m: WireSchema) => ({
    type: 'function',
    function: { name: m.name, description: m.description, parameters: m.inputSchema },
  });
  const noop = () => undefined;
  const logger = { debug: noop, info: noop, warn: noop, error: noop };
  const ctx = {
    sessionId: 'init-memory-real', workingDir: fixture,
    abortSignal: new AbortController().signal, logger,
  } as unknown as ToolContext;

  console.log(`model=${ZHIPU_CODING_TIER.model} endpoint=${ZHIPU_CODING_TIER.baseUrl} temperature=${TEMPERATURE} fixture=${fixture} rounds=${rounds}`);
  for (let round = 1; round <= rounds; round += 1) {
    console.log(`\n##### ROUND ${round}/${rounds}`);
    const messages: ChatMessage[] = [
      { role: 'system', content: `You are a coding assistant. Current working directory: ${fixture}` },
      { role: 'user', content: template },
    ];
    let loaded = false;
    let proposeCalls = 0;
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const tools = [
        wire(listDirectoryModule.schema), wire(readModule.schema), wire(toolSearchSchema),
        ...(loaded ? [wire(proposeProjectMemoryModule.schema)] : []),
      ];
      const response = await fetch(`${ZHIPU_CODING_TIER.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ZHIPU_CODING_TIER.model, messages, tools, tool_choice: 'auto',
          temperature: TEMPERATURE, max_tokens: MAX_OUTPUT_TOKENS,
        }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }> };
      const message = payload.choices?.[0]?.message;
      if (!message) throw new Error(`no assistant message: ${JSON.stringify(payload)}`);
      const calls = message.tool_calls ?? [];
      messages.push({ role: 'assistant', content: message.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
      if (calls.length === 0) {
        console.log('FINAL_REPLY<<<');
        console.log(message.content ?? '');
        console.log('>>>');
        break;
      }
      for (const call of calls) {
        const name = call.function?.name ?? '';
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* keep {} */ }
        let out: string;
        if (name === 'ToolSearch') {
          loaded = loaded || String(args.query ?? '').includes('ProposeProjectMemory');
          out = loaded ? 'Loaded tool: ProposeProjectMemory' : 'No matching deferred tools found';
        } else if (modules[name] && (name !== 'ProposeProjectMemory' || loaded)) {
          if (name === 'ProposeProjectMemory') proposeCalls += 1;
          const handler = await modules[name].createHandler();
          const result = await handler.execute(args, ctx, async () => ({ allow: true }));
          out = result.ok ? String(result.output) : `ERROR ${result.code}: ${result.error}`;
        } else {
          out = `ERROR unknown tool ${name}`;
        }
        console.log(`TOOL ${name}(${JSON.stringify(args)}) -> ${out.slice(0, 400)}`);
        messages.push({ role: 'tool', tool_call_id: call.id, content: out });
      }
    }
    console.log(`propose_calls=${proposeCalls}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
