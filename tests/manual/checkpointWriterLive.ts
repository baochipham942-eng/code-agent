// ============================================================================
// Checkpoint Writer 真实触发证据 harness（audit C-H1/C-H2 返工验收）
// ============================================================================
// 用法: npx tsx tests/manual/checkpointWriterLive.ts [--output-dir /tmp/checkpoint-live-evidence]
// 真实 LLM: 小米 MiMo (mimo-v2.5-pro, XIAOMI_API_URL)，key 来自 ~/.code-agent/.env
// 产出:
//   Part 1 — 真实会话 + 真实 taskStore 触发 writer，打印 checkpoint.md 全文
//   Part 2 — 模拟中断：同 session 走 tryInsertCheckpointRebuildBoundary 重建，
//            新 LLM 调用基于重建上下文续作，打印运行输出
//   report.md — 独立证据报告（git SHA、checkpoint、MEMORY、boundary、续作输出）
// ============================================================================

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Message } from '../../src/shared/contract';
import { runCheckpointWriterAgent } from '../../src/main/agent/checkpointWriterAgent';
import { createTask, updateTask } from '../../src/main/services/planning/taskStore';
import { tryInsertCheckpointRebuildBoundary } from '../../src/main/context/checkpoint';
import { CompressionState } from '../../src/main/context/compressionState';

// ---------------------------------------------------------------------------
// env 加载（~/.code-agent/.env，不覆盖已有值）
// ---------------------------------------------------------------------------
function loadEnv(): void {
  const envPath = path.join(os.homedir(), '.code-agent', '.env');
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^"|"$/g, '');
  }
}

// ---------------------------------------------------------------------------
// 真实 LLM：MiMo OpenAI 兼容端点（sgp 端点走 HTTPS_PROXY）
// ---------------------------------------------------------------------------
let llmCalls = 0;
async function mimoLlm(prompt: string): Promise<string> {
  llmCalls += 1;
  const baseUrl = process.env.XIAOMI_API_URL;
  const apiKey = process.env.XIAOMI_API_KEY;
  if (!baseUrl || !apiKey) throw new Error('XIAOMI_API_URL / XIAOMI_API_KEY missing');
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  console.log(`[llm] MiMo call #${llmCalls}, prompt ${prompt.length} chars`);
  const started = Date.now();
  const response = await axios.post(
    `${baseUrl.replace(/\/$/, '')}/chat/completions`,
    {
      model: 'mimo-v2.5-pro',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_completion_tokens: 8192,
      stream: false,
      thinking: { type: 'disabled' },
    },
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      httpsAgent: proxy ? new HttpsProxyAgent(proxy) : undefined,
      timeout: 300_000,
    },
  );
  const usage = response.data?.usage;
  console.log(`[llm] done in ${((Date.now() - started) / 1000).toFixed(1)}s, usage: ${JSON.stringify(usage)}`);
  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`empty MiMo response: ${JSON.stringify(response.data).slice(0, 400)}`);
  return content;
}

// ---------------------------------------------------------------------------
// 模拟一段真实开发会话（含 exact-form 字面量 / 错误修复 / 设计决策 / 未决问题）
// ---------------------------------------------------------------------------
const SESSION_ID = `live-evidence-${Date.now()}`;
const WORKING_DIR = path.resolve(new URL('.', import.meta.url).pathname, '../..');
const DEFAULT_OUTPUT_PARENT_DIR = path.join(os.tmpdir(), 'checkpoint-live-evidence');

function readArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) return args[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function safeGitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: WORKING_DIR,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

const OUTPUT_PARENT_DIR = readArg('--output-dir') ?? DEFAULT_OUTPUT_PARENT_DIR;
const OUTPUT_DIR = path.join(OUTPUT_PARENT_DIR, SESSION_ID);
const ROOT_DIR = path.join(OUTPUT_DIR, 'checkpoint-store');
const REPORT_PATH = path.join(OUTPUT_DIR, 'report.md');

let messageSeq = 0;
function msg(role: 'user' | 'assistant', content: string, toolCalls?: Message['toolCalls']): Message {
  messageSeq += 1;
  return {
    id: `live-m${messageSeq}`,
    role,
    content,
    timestamp: Date.now(),
    ...(toolCalls ? { toolCalls } : {}),
  } as Message;
}

// 模拟真实长会话中的工具输出噪音（让 Part 2 的 tail 选择真正发生头部压缩）
function fillerMessages(count: number): Message[] {
  const fillers: Message[] = [];
  for (let i = 0; i < count; i += 1) {
    fillers.push(msg('assistant', [
      `读取并分析了第 ${i + 1} 批源文件。`,
      'export interface CheckpointSection { number: number; heading: string; instruction: string; budgetTokens: number; }'.repeat(60),
      `第 ${i + 1} 批分析结论：结构与模板一致，继续下一批。`,
    ].join('\n'), [
      { id: `tf${i}`, name: 'Read', arguments: { file_path: `src/main/context/checkpoint/file${i}.ts` } },
    ] as Message['toolCalls']));
  }
  return fillers;
}

function buildConversation(): Message[] {
  return [
    msg('user', '帮我把 checkpoint writer 从本地模板函数改成真 LLM 后台子代理，11 段都要由 LLM 从会话内容产出。注意保留配置 `CHECKPOINT_WRITER.LLM_MAX_ATTEMPTS=2`，跑测试用 `npx vitest run tests/unit/agent/`。'),
    ...fillerMessages(8),
    msg('assistant', '收到。我先读现有实现：checkpointWriterAgent.ts 里 buildCheckpoint 是纯模板填充，§4/§7/§8/§10/§11 硬编码 (none)。计划：新增 checkpointWriterPrompt 模块 + runner 内 spawn LLM 子代理。', [
      { id: 't1', name: 'Read', arguments: { file_path: 'src/main/agent/checkpointWriterAgent.ts' } },
      { id: 't2', name: 'Read', arguments: { file_path: 'src/main/context/checkpoint/templates.ts' } },
    ] as Message['toolCalls']),
    msg('user', '对，按 TDD 来。先写失败测试再实现。'),
    msg('assistant', '写了 5 个失败测试后实现完成。期间发现并修了一个潜在 bug：getSectionBody 的正则带 m 标志，\\s*$ 在每个行尾命中，多行 section body 被静默截断成首行——§4 多行任务树直接踩中。去掉 m 标志后修复。', [
      { id: 't3', name: 'Edit', arguments: { file_path: 'src/main/context/checkpoint/templates.ts' } },
      { id: 't4', name: 'Bash', arguments: { command: 'npx vitest run tests/unit/agent/' } },
    ] as Message['toolCalls']),
    msg('user', '验证策略你怎么定的？'),
    msg('assistant', '设计决策：与上游 MiMo 不同，上游 writer 用 Edit 工具直接改文件、事后由 splitover 插件校验；我们让子代理产出完整文档，runner 先用强化版 validator 验证再原子写入。理由是生产者与落盘之间要有独立闸门，LLM 输出不合格不污染旧 checkpoint。遗留一个开放问题：notes.md 是否要在每轮 writer 后重置为模板，目前没有生产者往里写，先不做。'),
    msg('user', '可以。重建边界那边的超时记得调，writer 现在是真 LLM 了。'),
    msg('assistant', 'CHECKPOINT_WRITER 保留后台 90s writer 上限，但主循环插重建边界只短等 5s。超时或写失败仍然 fail-closed 跳过边界、落回 summary 压缩，边界协调机制本身不动。'),
  ];
}

function seedTaskStore(): void {
  const t1 = createTask(SESSION_ID, { subject: 'checkpoint writer 子代理化返工 (C-H1/H2)' });
  const t11 = createTask(SESSION_ID, { subject: '移植 checkpoint-writer prompt 并接 taskStore', parentTaskId: t1.id });
  const t12 = createTask(SESSION_ID, { subject: '真实触发产出 11 段 checkpoint 证据', parentTaskId: t1.id });
  const t2 = createTask(SESSION_ID, { subject: '中断续作运行证据' });
  updateTask(SESSION_ID, t11.id, { status: 'completed' });
  updateTask(SESSION_ID, t12.id, { status: 'in_progress' });
  void t2;
}

async function main(): Promise<void> {
  loadEnv();
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });
  seedTaskStore();
  const conversation = buildConversation();
  const report: string[] = [
    '# Checkpoint Writer Live Evidence',
    '',
    `- sessionId: ${SESSION_ID}`,
    `- gitSha: ${safeGitSha()}`,
    `- workingDirectory: ${WORKING_DIR}`,
    `- outputDir: ${OUTPUT_DIR}`,
    `- checkpointStore: ${ROOT_DIR}`,
  ];

  console.log('='.repeat(76));
  console.log(`PART 1 — 真实触发 checkpoint writer (session=${SESSION_ID})`);
  console.log('='.repeat(76));
  const result = await runCheckpointWriterAgent(
    {
      sessionId: SESSION_ID,
      workingDirectory: WORKING_DIR,
      messages: conversation,
      reason: 'manual',
      rootDir: ROOT_DIR,
    },
    { llm: mimoLlm },
  );
  console.log(`\nwriter result: success=${result.success}${result.error ? ` error=${result.error}` : ''}`);
  if (!result.success) process.exit(1);

  const checkpoint = readFileSync(result.checkpointPath, 'utf-8');
  console.log(`\n----- checkpoint.md 全文 (${result.checkpointPath}) -----\n`);
  console.log(checkpoint);
  console.log('----- checkpoint.md 结束 -----\n');
  const memory = readFileSync(result.memoryPath, 'utf-8');
  console.log(`----- MEMORY.md 全文 (${result.memoryPath}) -----\n${memory}\n----- MEMORY.md 结束 -----`);
  report.push(
    '',
    '## Part 1 Writer Result',
    '',
    `- success: ${result.success}`,
    `- checkpointPath: ${result.checkpointPath}`,
    `- memoryPath: ${result.memoryPath}`,
    '',
    '### checkpoint.md',
    '',
    '```md',
    checkpoint,
    '```',
    '',
    '### MEMORY.md',
    '',
    '```md',
    memory,
    '```',
  );

  console.log('\n' + '='.repeat(76));
  console.log('PART 2 — 模拟中断后续作：插入重建边界 + 新 LLM 调用从 checkpoint 续作');
  console.log('='.repeat(76));
  // 中断后恢复的会话：消息又涨了两条（待压缩），与产品内 pressure 触发场景一致
  const resumedMessages = [
    ...conversation,
    msg('user', '继续，把剩下的证据跑完'),
    msg('assistant', '正在准备中断续作证据。'),
  ];
  const runtime = {
    sessionId: SESSION_ID,
    workingDirectory: WORKING_DIR,
    messages: resumedMessages,
    onEvent: () => {},
    persistMessage: async () => {},
    compressionState: new CompressionState(),
    checkpointRootDir: ROOT_DIR,
  };
  const boundary = await tryInsertCheckpointRebuildBoundary(runtime);
  console.log(`\nboundary: inserted=${boundary.inserted} reason=${boundary.reason} compacted=${boundary.compactedMessageCount ?? 0} 条消息`);
  if (!boundary.inserted) process.exit(1);

  const marker = runtime.messages[0];
  console.log(`边界 marker 注入后会话长度: ${runtime.messages.length}（marker + 保留 tail）`);

  // 新 session 的第一轮：上下文 = 重建 marker，提问续作
  const continuation = await mimoLlm([
    'You are a coding agent resuming an interrupted session. The following is your rebuilt context from the checkpoint boundary:',
    '',
    marker.content,
    '',
    'New user message: "上个会话中断了。基于 checkpoint 回答：1) 用户的原始意图是什么（引用原话）；2) 任务树各任务的当前状态；3) 下一步该做什么；4) 有哪些必须逐字保留的配置。"',
  ].join('\n'));
  console.log('\n----- 续作运行输出（MiMo 基于重建上下文） -----\n');
  console.log(continuation);
  console.log('\n----- 续作输出结束 -----');
  console.log(`\n共 ${llmCalls} 次真实 LLM 调用`);
  report.push(
    '',
    '## Part 2 Rebuild Boundary',
    '',
    `- inserted: ${boundary.inserted}`,
    `- reason: ${boundary.reason}`,
    `- compactedMessageCount: ${boundary.compactedMessageCount ?? 0}`,
    `- messagesAfterBoundary: ${runtime.messages.length}`,
    '',
    '### Boundary Marker',
    '',
    '```md',
    String(marker.content ?? ''),
    '```',
    '',
    '### Continuation Output',
    '',
    '```md',
    continuation,
    '```',
    '',
    `LLM calls: ${llmCalls}`,
  );
  writeFileSync(REPORT_PATH, `${report.join('\n')}\n`, 'utf-8');
  console.log(`\n证据报告: ${REPORT_PATH}`);
}

main().catch((error) => {
  console.error('harness failed:', error);
  process.exit(1);
});
