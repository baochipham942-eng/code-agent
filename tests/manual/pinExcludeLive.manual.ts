// Manual GLM run for pin/exclude compaction. Not a vitest file.
// Usage: npx tsx tests/manual/pinExcludeLive.manual.ts
// Key: ZHIPU_CODING_API_KEY from ~/.code-agent/.env. Never print the key.

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Message } from '../../src/shared/contract';
import { ModelRouter } from '../../src/host/model/modelRouter';
import type { ModelMessage, ModelResponse } from '../../src/host/model/types';
import { ContextAssembly } from '../../src/host/agent/runtime/contextAssembly';
import { AutoContextCompressor } from '../../src/host/context/autoCompressor';
import { CompressionPipeline } from '../../src/host/context/compressionPipeline';
import { CompressionState } from '../../src/host/context/compressionState';
import { ContextHealthState } from '../../src/host/agent/runtime/contextHealthState';
import { TurnState } from '../../src/host/agent/runtime/turnState';
import { getContextInterventionState } from '../../src/host/context/contextInterventionState';

const GLM_URL = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions';
const GLM_MODEL = 'glm-5.3';
const FACT = 'release date is 3 Nov';
const SECRET = 'quartz-ledger-91c4';
const PLACEHOLDER = '[excluded from model context]';
const QUESTION = 'What is the release date stated in the conversation? Reply with the date only, or UNKNOWN if it was not stated.';

function loadKey(): string {
  const envPath = path.join(os.homedir(), '.code-agent', '.env');
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^ZHIPU_CODING_API_KEY=(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1].replace(/^"|"$/g, '').trim();
    if (!key) break;
    return key;
  }
  throw new Error('ZHIPU_CODING_API_KEY missing');
}

const apiKey = loadKey();
const captured: Array<{ role: string; content: string }>[] = [];
const glmModels: string[] = [];

// Full message text is what the economics gate counts. The summariser only
// sees a clamped head and tail, so a long repeated pad clears the 500-token
// net-savings floor without putting the buried fact into the summary prompt.
const PAD_REPEAT = 600;

async function glmChat(messages: Array<{ role: string; content: string }>): Promise<string> {
  const response = await fetch(GLM_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GLM_MODEL,
      temperature: 0,
      messages,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GLM ${response.status}: ${body.slice(0, 400)}`);
  }
  const parsed = JSON.parse(body) as {
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
  };
  if (parsed.model) glmModels.push(parsed.model);
  const content = parsed.choices?.[0]?.message?.content ?? '';
  if (!content.trim()) throw new Error('GLM returned empty content');
  console.error(`glm reply model=${parsed.model ?? 'unknown'} chars=${content.length}`);
  return content;
}

ModelRouter.prototype.inference = (async function inference(messages: ModelMessage[]): Promise<ModelResponse> {
  console.error(`patched inference entered messages=${messages.length}`);
  const glmMessages = messages.map((message) => ({
    role: message.role === 'assistant' || message.role === 'system' || message.role === 'user'
      ? message.role
      : 'user',
    content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
  }));
  captured.push(glmMessages);
  const content = await glmChat(glmMessages);
  return { type: 'text', content, finishReason: 'stop' };
}) as typeof ModelRouter.prototype.inference;

function pad(repeat = PAD_REPEAT): string {
  return 'hard compaction transcript '.repeat(repeat);
}

function factMessage(): Message {
  const filler = pad();
  const at = 1100;
  return {
    id: 'fact-user',
    role: 'user',
    content: `${filler.slice(0, at)}${FACT}${filler.slice(at)}`,
    timestamp: 1,
  };
}

function plain(id: string, role: Message['role'], content: string, timestamp: number): Message {
  return { id, role, content, timestamp };
}

function pinnedFixture(): Message[] {
  return [
    factMessage(),
    plain('pad-a', 'assistant', pad(), 2),
    plain('pad-b', 'user', pad(), 3),
    plain('pad-c', 'assistant', pad(), 4),
    plain('later-user', 'user', 'what is the status now', 5),
    plain('tail', 'assistant', 'tail reply', 6),
  ];
}

function excludedFixture(): Message[] {
  return [
    plain('excluded-ledger', 'assistant', `${SECRET} ${pad(40)}`, 1),
    plain('pad-a', 'user', pad(), 2),
    plain('pad-b', 'assistant', pad(), 3),
    plain('pad-c', 'user', pad(), 4),
    plain('later-user', 'user', 'what is the status now', 5),
    plain('tail', 'assistant', 'tail reply', 6),
  ];
}

function makeCtx(sessionId: string, messages: Message[]) {
  return {
    sessionId,
    agentId: undefined,
    messages,
    hookMessageBuffer: { add: () => undefined, flush: () => '', size: 0 },
    onEvent: () => undefined,
    modelConfig: { model: 'glm-5.3', provider: 'zhipu', maxTokens: 1024 },
    toolRegistry: { getDeferredToolsSummary: () => '' },
    workingDirectory: os.tmpdir(),
    isDefaultWorkingDirectory: true,
    turn: TurnState.forTest({ isSimpleTaskMode: false }),
    compressionPipeline: new CompressionPipeline(),
    contextHealth: ContextHealthState.forTest({
      persistentSystemContext: [],
      compressionState: new CompressionState(),
    } as never),
    autoCompressor: new AutoContextCompressor({
      enabled: true,
      triggerTokens: 200,
      preserveRecentCount: 2,
      warningThreshold: 0.75,
    }),
    systemPrompt: '',
    hookManager: undefined,
    MAX_CONSECUTIVE_COMPACTS: 2,
  };
}

function snippet(text: string, needle: string): string {
  const index = text.indexOf(needle);
  if (index < 0) return '';
  return text.slice(Math.max(0, index - 80), index + needle.length + 80);
}

async function runCase(label: string, sessionId: string, messages: Message[], pinId?: string, excludeId?: string) {
  const interventions = getContextInterventionState();
  if (pinId) interventions.applyIntervention(sessionId, undefined, pinId, 'pin', true);
  if (excludeId) interventions.applyIntervention(sessionId, undefined, excludeId, 'exclude', true);
  const before = captured.length;
  const ctx = makeCtx(sessionId, messages);
  const assembly = new ContextAssembly(ctx as never);
  try {
    await assembly.checkAndAutoCompress();
  } catch (error) {
    console.error(`${label} checkAndAutoCompress threw`, error instanceof Error ? error.message : String(error));
  }
  const promptCalls = captured.slice(before);
  const promptText = promptCalls.map((call) => call.map((message) => message.content).join('\n')).join('\n---\n');
  const compaction = messages.find((message) => message.compaction);
  const summary = compaction?.content ?? '';
  const runtimeIds = messages.map((message) => message.id);
  let answer = '';
  let requestPreview: Array<{ role: string; id?: string; hasFact: boolean; hasSecret: boolean; hasPlaceholder: boolean; snippet: string }> = [];
  if (compaction) {
    const requestMessages = [
      ...messages.map((message) => ({
        role: message.role === 'system' ? 'system' as const : message.role,
        content: message.content,
      })),
      { role: 'user' as const, content: QUESTION },
    ];
    requestPreview = messages.map((message) => ({
      role: message.role,
      id: message.id,
      hasFact: message.content.includes(FACT),
      hasSecret: message.content.includes(SECRET),
      hasPlaceholder: message.content.includes(PLACEHOLDER),
      snippet: snippet(message.content, FACT) || snippet(message.content, SECRET) || message.content.slice(0, 180),
    }));
    answer = await glmChat(requestMessages);
    console.error(`${label} answer chars=${answer.length} hasFact=${answer.includes('3 Nov') || answer.includes('November 3')}`);
  }
  if (pinId) interventions.applyIntervention(sessionId, undefined, pinId, 'pin', false);
  if (excludeId) interventions.applyIntervention(sessionId, undefined, excludeId, 'exclude', false);
  return {
    label,
    compacted: Boolean(compaction),
    runtimeIds,
    promptCalls: promptCalls.length,
    promptHasFact: promptText.includes(FACT),
    promptHasSecret: promptText.includes(SECRET),
    promptHasPlaceholder: promptText.includes(PLACEHOLDER),
    promptExcerpt: promptText.slice(0, 1500),
    summary,
    summaryHasFact: summary.includes(FACT) || summary.includes('3 Nov'),
    summaryHasSecret: summary.includes(SECRET),
    requestPreview,
    answer,
  };
}

async function main(): Promise<void> {
  const outDir = path.join(os.homedir(), 'work', 'out', 'N-CTX-PIN-EXCLUDE-MENU');
  mkdirSync(outDir, { recursive: true });
  const pinned = await runCase('pinned', `live-pin-${Date.now()}`, pinnedFixture(), 'fact-user');
  const control = await runCase('control', `live-control-${Date.now()}`, pinnedFixture());
  const excluded = await runCase('excluded', `live-exclude-${Date.now()}`, excludedFixture(), undefined, 'excluded-ledger');
  const report = { model: GLM_MODEL, endpoint: GLM_URL, glmModels, pinned, control, excluded };
  const outFile = path.join(outDir, 'glm-e2e.json');
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    outFile,
    pinned: { compacted: pinned.compacted, ids: pinned.runtimeIds, promptHasFact: pinned.promptHasFact, answer: pinned.answer },
    control: { compacted: control.compacted, ids: control.runtimeIds, promptHasFact: control.promptHasFact, summaryHasFact: control.summaryHasFact, answer: control.answer },
    excluded: {
      compacted: excluded.compacted,
      ids: excluded.runtimeIds,
      promptHasSecret: excluded.promptHasSecret,
      promptHasPlaceholder: excluded.promptHasPlaceholder,
      summaryHasSecret: excluded.summaryHasSecret,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
