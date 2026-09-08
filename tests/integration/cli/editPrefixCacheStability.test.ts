// ============================================================================
// N-EDIT-CACHEKEY 回归门：edit 链路的 provider 前缀缓存稳定性。
//
// 背景：buildAiSdkPrompt 会把全部非 transient system 消息提升进请求最前的
// instructions。逐轮变化的注记（<thinking>/<goal-checkpoint>/<current-plan>）
// 一旦落进持久历史，就会在下一轮请求把 system+历史前缀整体打断，DeepSeek 系
// 自动前缀缓存归 0（实测 edit 题成本 9.4×）。本测试用脚本化假 provider 驱动
// 真实 CLI 全链路（Read → Edit → final），断言第 N+1 个请求是第 N 个请求的
// 字节级前缀扩展（尾部 transient reminder 除外）——这正是前缀缓存命中的
// 充要条件，等价于验收③的「第二次请求 cache_read > 0」的 hermetic 判定。
//
// 反向变异：把 modeInjection.maybeInjectThinking 改回 injectSystemMessage
// （落 ledger），本测试在 req-3 前缀断言上转红。
// ============================================================================
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const tempDirs: string[] = [];

interface WireMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ function?: { name?: string } }>;
}

interface WireRequest {
  model: string;
  stream?: boolean;
  tools?: unknown;
  messages: WireMessage[];
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function scriptedTurn(requestIndex: number, workspace: string) {
  const filePath = path.join(workspace, 'prompt-smoke-edit.txt');
  if (requestIndex === 1) {
    return {
      toolCall: { id: 'call_read_1', name: 'Read', arguments: JSON.stringify({ file_path: filePath }) },
    };
  }
  if (requestIndex === 2) {
    return {
      toolCall: {
        id: 'call_edit_1',
        name: 'Edit',
        arguments: JSON.stringify({
          file_path: filePath,
          edits: [{ old_text: 'color=red', new_text: 'color=blue' }],
        }),
      },
    };
  }
  return { text: 'Done. color is now blue.' };
}

function startScriptedProvider(workspace: string): Promise<{
  baseUrl: string;
  server: Server;
  requests: WireRequest[];
}> {
  const requests: WireRequest[] = [];
  let agentTurnCount = 0;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body) as WireRequest;
      // 非 agent-loop 调用（复杂度判定等 quick-model 探测：无 tools、非流式）：
      // 固定回文本，不占脚本化轮次
      const isAgentTurn = Array.isArray(parsed.tools) && (parsed.tools as unknown[]).length > 0;
      if (!isAgentTurn) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          id: 'chatcmpl-probe',
          object: 'chat.completion',
          created: 0,
          model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      agentTurnCount += 1;
      requests.push(parsed);
      const turn = scriptedTurn(agentTurnCount, workspace);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      const base = { id: `chatcmpl-stub-${agentTurnCount}`, object: 'chat.completion.chunk', created: 0, model: 'fake-model' };
      if (turn.toolCall) {
        const { id, name, arguments: args } = turn.toolCall;
        response.write(sseChunk({
          ...base,
          choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] } }],
        }));
        response.write(sseChunk({
          ...base,
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }],
        }));
        response.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
      } else {
        response.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: turn.text } }] }));
        response.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
      }
      response.end('data: [DONE]\n\n');
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('scripted provider did not bind a TCP port'));
        return;
      }
      resolve({ baseUrl: `http://127.0.0.1:${address.port}/v1`, server, requests });
    });
  });
}

function runCli(dataDir: string, workspace: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx', 'src/cli/index.ts',
      '--project', workspace,
      '--provider', 'custom',
      '--model', 'fake-model',
      '--output-format', 'text',
      'run', 'Read prompt-smoke-edit.txt, then change color=red to color=blue.',
      '--dangerously-skip-permissions',
    ], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: dataDir,
        CODE_AGENT_DATA_DIR: path.join(dataDir, 'data'),
        CUSTOM_PROVIDER_API_KEY: 'fake-key',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function isTransientReminder(message: WireMessage): boolean {
  return message.role === 'user'
    && typeof message.content === 'string'
    && message.content.startsWith('<system-reminder>');
}

/** 稳定前缀 = 去掉尾部 transient reminder 后的消息序列 */
function stablePrefixOf(request: WireRequest): WireMessage[] {
  const messages = request.messages;
  if (messages.length > 0 && isTransientReminder(messages[messages.length - 1])) {
    return messages.slice(0, -1);
  }
  return messages;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('edit 链路 provider 前缀缓存稳定性（N-EDIT-CACHEKEY）', () => {
  it('逐轮请求互为字节级前缀扩展，逐轮注记只出现在尾部 transient reminder', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'code-agent-edit-cachekey-'));
    tempDirs.push(tempDir);
    const workspace = path.join(tempDir, 'ws');
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'prompt-smoke-edit.txt'), 'color=red\nshape=square\n', 'utf-8');

    const { baseUrl, server, requests } = await startScriptedProvider(workspace);
    try {
      const dataDir = path.join(tempDir, 'data');
      await mkdir(dataDir, { recursive: true });
      await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
        models: {
          defaultProvider: 'custom',
          default: 'custom',
          providers: {
            custom: { enabled: true, model: 'fake-model', baseUrl },
          },
          routing: {
            chat: { provider: 'custom', model: 'fake-model' },
            code: { provider: 'custom', model: 'fake-model' },
            fast: { provider: 'custom', model: 'fake-model' },
          },
        },
      }), 'utf-8');

      const result = await runCli(tempDir, workspace);
      expect(result.code, result.stderr).toBe(0);
      expect(await readFile(path.join(workspace, 'prompt-smoke-edit.txt'), 'utf-8')).toContain('color=blue');

      // 脚本应答固定 3 轮：Read → Edit → final
      expect(requests).toHaveLength(3);

      // tools schema 逐轮逐字节稳定（工具顺序/内容抖动同样击穿前缀缓存）
      const toolsJson = requests.map((r) => JSON.stringify(r.tools));
      expect(toolsJson[1]).toBe(toolsJson[0]);
      expect(toolsJson[2]).toBe(toolsJson[0]);

      // 核心断言：第 N+1 个请求的稳定前缀必须完整覆盖第 N 个请求
      // （= 第二轮起 input_tokens_cache_read > 0 的充要条件）
      for (const pair of [[0, 1], [1, 2]] as const) {
        const prev = stablePrefixOf(requests[pair[0]]);
        const next = requests[pair[1]].messages;
        expect(next.length).toBeGreaterThan(prev.length);
        for (const [i, message] of prev.entries()) {
          expect(
            JSON.stringify(next[i]),
            `req-${pair[1] + 1} 的 messages[${i}] 与 req-${pair[0] + 1} 不一致（前缀在第 ${i} 条断开）`,
          ).toBe(JSON.stringify(message));
        }
      }

      // 注记仍然送达模型，但只许出现在尾部 transient reminder 里
      const finalReminder = requests[2].messages[requests[2].messages.length - 1];
      expect(isTransientReminder(finalReminder)).toBe(true);
      expect(finalReminder.content).toContain('<thinking>');
      expect(finalReminder.content).toContain('<goal-checkpoint>');
      // 反向锚点：注记不得以独立 system 消息的形式插进前缀（ hoist 回归 ）
      for (const request of requests) {
        const lastIndex = request.messages.length - 1;
        for (const [i, message] of request.messages.entries()) {
          if (i === 0) continue; // messages[0] 是主 system prompt
          if (i === lastIndex && isTransientReminder(message)) continue; // 尾部 transient reminder 是注记的合法位置
          expect(
            typeof message.content === 'string'
              && (message.content.includes('<thinking>') || message.content.includes('<goal-checkpoint>')),
            `req 的 messages[${i}] 出现脱离尾巴的逐轮注记`,
          ).toBe(false);
        }
      }
    } finally {
      server.close();
    }
  }, 120_000);
});
