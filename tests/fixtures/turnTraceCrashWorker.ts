import path from 'node:path';

import { TurnTraceRecorder } from '../../src/host/agent/runtime/turnTrace';

const [dataDir, sessionId] = process.argv.slice(2);
if (!dataDir || !sessionId) throw new Error('usage: turnTraceCrashWorker <dataDir> <sessionId>');

const recorder = new TurnTraceRecorder(sessionId, path.join(dataDir, 'traces'));
recorder.setTurn(1);
recorder.record('request_manifest', {
  requestId: 'crash-readable-request',
  messageRefs: [{ kind: 'system_prompt', contentHash: 'a'.repeat(64) }],
  toolSchemaHash: 'b'.repeat(64),
  toolNames: ['Read'],
  requested: {
    provider: 'fixture', model: 'fixture-model', temperature: null, maxTokens: null,
    reasoningEffort: null, thinkingBudget: null,
  },
  actualProvider: 'fixture',
  actualModel: 'fixture-model',
  appVersion: 'test',
  adapterDefaults: { engine: 'aisdk', temperature: null, maxTokens: null },
  compactionReplacements: [],
  degraded: false,
});
recorder.record('inference', {
  responseType: 'tool_use', durationMs: 10, inputTokens: 20, outputTokens: 3,
  finishReason: 'tool_calls', truncated: false,
});
recorder.record('loop_decision', {
  action: 'continue', execution: 'advisory', reason: 'fixture tool pending',
  stopReason: 'tool_calls', consecutiveErrors: 0, contextRatio: 0.1,
});
recorder.record('tool_dispatch', {
  toolName: 'Read', success: true, durationMs: 5, error: null, fromCache: false,
});
recorder.record('inference', {
  responseType: 'tool_use', durationMs: 10, inputTokens: 24, outputTokens: 3,
  finishReason: 'tool_calls', truncated: false,
});
recorder.record('loop_decision', {
  action: 'continue', execution: 'advisory', reason: 'second fixture tool pending',
  stopReason: 'tool_calls', consecutiveErrors: 0, contextRatio: 0.1,
});
recorder.record('tool_dispatch', {
  toolName: 'Read', success: true, durationMs: 4, error: null, fromCache: false,
});
recorder.record('inference', {
  responseType: 'text', durationMs: 8, inputTokens: 28, outputTokens: 5,
  finishReason: 'stop', truncated: false,
});

process.stdout.write(`${JSON.stringify({ marker: 'incremental-flush-complete', sessionId })}\n`);
// 常驻等测试 SIGKILL；但 vitest worker 自己被杀（harness 收后台任务）时 afterEach 不会跑，
// 本进程会被 launchd 收养（ppid=1）后永远挂着（09-02 收掉 3 个挂了 2–3 天的）。父死即自退。
setInterval(() => {
  if (process.ppid === 1) process.exit(0);
}, 1_000);
