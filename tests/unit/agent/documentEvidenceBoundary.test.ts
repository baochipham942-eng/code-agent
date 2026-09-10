import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, ToolCall } from '../../../src/shared/contract';
import { attachDocumentOrigin, checkDocumentEvidenceClaims, documentClaimPreflight, boundDocumentEvidenceClaims } from '../../../src/host/agent/runtime/documentEvidenceBoundary';
import { readbackFileEvidence } from '../../../src/host/agent/runtime/fileEvidenceReadback';
import { createDocumentEvidenceStream } from '../../../src/host/agent/runtime/documentEvidenceStream';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const call = (name: string, path: string): ToolCall => ({ id: `${name}-${path}`, name, arguments: { file_path: path } });
const user: Message = { id: 'user', role: 'user', content: '整理来源与空间盘点', timestamp: 1 };
const userSaying = (content: string): Message => ({ id: 'u', role: 'user', content, timestamp: 1 });

describe('document evidence boundary', () => {
  it('keeps transcript and generated minutes in one digest-bound origin family across sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-origins-')); roots.push(root);
    const transcript = join(root, 'transcript.md'); const minutes = join(root, 'minutes.md');
    const ledger = join(root, 'ledger.jsonl');
    await writeFile(transcript, 'Source: latency estimate 400ms');
    const input = await attachDocumentOrigin(call('Read', transcript), { toolCallId: 'read', success: true, output: 'source' }, [], root, ledger);
    await writeFile(minutes, 'Summary: latency estimate 400ms');
    await attachDocumentOrigin(call('Write', minutes), { toolCallId: 'write', success: true }, [user,
      { ...user, id: 'source', role: 'tool', toolResults: [input] }], root, ledger);
    const later = await attachDocumentOrigin(call('Read', minutes), { toolCallId: 'later', success: true }, [], root, ledger);
    expect(later.metadata?.documentOrigin).toMatchObject({ kind: 'derived', roots: (input.metadata?.documentOrigin as { roots: string[] }).roots });
    expect(later.output).toContain('source independence unverified');
    await writeFile(minutes, 'Externally replaced document');
    const changed = await attachDocumentOrigin(call('Read', minutes), { toolCallId: 'changed', success: true }, [], root, ledger);
    expect(changed.metadata?.documentOrigin).toMatchObject({ kind: 'unclassified' });
    expect((await readFile(ledger, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it.each([
    '至少两处相互独立的记载口径一致',
    '✅ 双记录一致：纪要 + 逐字稿',
    '✅ 官网两条新闻互证，同源',
    'Confirmed by independent sources',
  ])('rejects an unsupported independence upgrade: %s', (text) => {
    expect(checkDocumentEvidenceClaims(text, [user])).toContain('SOURCE_INDEPENDENCE_UNVERIFIED');
  });

  it.each([
    ['空间主人 | Neo 登录用户，owner | 实测', 'SPACE_OWNER_UNVERIFIED'],
    ['成员与专家 | agents/ 下的本地专家名册 | 实测', 'SPACE_MEMBERS_UNVERIFIED'],
    ['定时自动化 | registered:[]，当前没有定时任务 | 实测', 'SPACE_AUTOMATIONS_UNVERIFIED'],
  ])('rejects machine facts as space measurements: %s', (text, code) => {
    expect(checkDocumentEvidenceClaims(text, [user])).toContain(code);
  });

  it('accepts scoped owner and empty automation evidence only from a matching successful query', () => {
    const query: ToolCall = { id: 'query', name: 'space_query', arguments: { projectId: 'project-fixture' } };
    const messages: Message[] = [user,
      { ...user, id: 'call', role: 'assistant', toolCalls: [query] },
      { ...user, id: 'result', role: 'tool', toolResults: [{ toolCallId: 'query', success: true,
        output: JSON.stringify({ space: { id: 'project-fixture', cloudProjectId: 'cloud-fixture' },
          cloudMembers: [{ projectId: 'cloud-fixture', role: 'owner', userId: 'owner-fixture' }],
          capabilities: { experts: [{ id: 'expert-fixture', displayName: 'Expert fixture' }], automations: [] } }) }] },
    ];
    const report = '空间 project-fixture。\n空间主人 owner-fixture，实测。\n当前没有定时自动化。';
    expect(checkDocumentEvidenceClaims(report, messages)).toEqual([]);
    expect(checkDocumentEvidenceClaims(report.replace('project-fixture', 'other-project'), messages)).toContain('SPACE_OWNER_UNVERIFIED');
    expect(checkDocumentEvidenceClaims(report.replace('owner-fixture', 'login-user'), messages)).toContain('SPACE_OWNER_UNVERIFIED');
    const scoped = '空间 project-fixture。空间主人 owner-fixture，自动化配置待查。空间专家成员：expert-fixture。';
    expect(checkDocumentEvidenceClaims(scoped, messages)).toEqual([]);
    expect(documentClaimPreflight({ id: 'scoped-write', name: 'Write', arguments: { file_path: 'report.md', content: scoped } }, messages)).toEqual([]);
    expect(checkDocumentEvidenceClaims(scoped, [...messages, { ...user, id: 'next-turn' }])).toEqual(['SPACE_OWNER_UNVERIFIED', 'SPACE_MEMBERS_UNVERIFIED']);
    // 归属作用域：owner 记录必须属于**这个** space 的 cloudProjectId。别的云项目里的 owner 行
    // 不能给本空间的归属断言背书——去掉 member.projectId 那道比对，上面所有断言仍然全绿
    // （fixture 里两者恰好相等），这条才是真正钉住作用域的那一条。
    const foreignOwner: Message[] = [user,
      { ...user, id: 'call', role: 'assistant', toolCalls: [query] },
      { ...user, id: 'result', role: 'tool', toolResults: [{ toolCallId: 'query', success: true,
        output: JSON.stringify({ space: { id: 'project-fixture', cloudProjectId: 'cloud-fixture' },
          cloudMembers: [{ projectId: 'another-cloud-project', role: 'owner', userId: 'owner-fixture' }],
          capabilities: { experts: [{ id: 'expert-fixture', displayName: 'Expert fixture' }], automations: [] } }) }] },
    ];
    expect(checkDocumentEvidenceClaims(report, foreignOwner)).toContain('SPACE_OWNER_UNVERIFIED');

  });

  // ai-review #1740 Important：作用域信号不能是「文本里出现过『空间/space』」——中文里
  // 磁盘空间 / 内存空间 / 向量空间 / 命名空间 / 空间复杂度全都跟 Neo 空间无关。实测旧口径下
  // 「该结构体的成员按 4 字节对齐，专家建议保持这个布局。」整句被替换成两条「空间成员与专家
  // 待查」，正文一个字都没剩，同会话里写含「成员」的 .md 也被 Write 前置检查拦掉。
  it.each([
    ['向量空间语境下的结构体成员', [userSaying('看看这个向量空间的结构体')], '该结构体的成员按 4 字节对齐，专家建议保持这个布局。'],
    ['磁盘空间 + 自动化流水线', [userSaying('磁盘空间还够吗')], '磁盘空间充足。我们的自动化流水线每晚跑一次。'],
    ['命名空间 + 成员', [userSaying('这个命名空间怎么组织')], '命名空间里的成员按字母序排列。'],
    ['英文 space between fields', [userSaying('describe the struct layout')], 'The struct members are 4-byte aligned; the space between fields is padding.'],
  ])('leaves an unrelated answer verbatim: %s', (_label, messages, answer) => {
    expect(checkDocumentEvidenceClaims(answer, messages)).toEqual([]);
    expect(boundDocumentEvidenceClaims(answer, messages).content).toBe(answer);
    expect(documentClaimPreflight({ id: 'w', name: 'Write', arguments: { file_path: 'notes.md', content: answer } }, messages)).toEqual([]);
  });

  // ai-review #1740 Important：「读不回内容」不等于「文件不存在」。一个 30MB 的交付物确实在盘上，
  // 只是超过摘要读取上限；基线的 statSync().isFile() 对它是放行的。合并成同一条打回理由会让
  // attempt_completion 被反复打回到预算耗尽，提示词还说「产物不可读」。
  it('an oversized deliverable still proves existence, without claiming its content was read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oversized-')); roots.push(root);
    const big = join(root, 'deliverable.mp4');
    await writeFile(big, Buffer.alloc(11 * 1024 * 1024));
    const { evidence, documentText } = readbackFileEvidence(big, root, 'test');
    expect(evidence.ref).toContain('deliverable.mp4');
    expect(evidence.freshness.state).toBe('candidate');
    expect(evidence.freshness.digest).toBeUndefined();
    expect(documentText).toBeUndefined();
    expect(() => readbackFileEvidence(join(root, 'missing.md'), root, 'test')).toThrow();
  });

  // ai-review #1740 Important 的配套契约：证据流把正文攒到 finish 才发布，所以在它之前
  // 缓冲区必须是无损可取的——取消/转向时 finish 根本执行不到，半截回答要靠调用方留住。
  it('an unfinished stream still holds everything it was given', () => {
    const emitted: string[] = [];
    const stream = createDocumentEvidenceStream([], (text) => emitted.push(text));
    stream.push('前半句');
    stream.push('后半句');
    expect(emitted).toEqual([]);
    expect(stream.pending).toBe('前半句后半句');
  });

  it('does not allow an unrelated caveat to license an unsupported measured row', () => {
    expect(checkDocumentEvidenceClaims('空间字段待补。\n空间主人 | 登录用户 owner | 实测', [user])).toContain('SPACE_OWNER_UNVERIFIED');
  });

  it('allows explicit evidence boundaries', () => {
    expect(checkDocumentEvidenceClaims('纪要和逐字稿同源，不能证明独立来源。\n空间主人待查。\n定时自动化当前状态未知，日志仅能说明启动时点。', [user])).toEqual([]);
  });

  it('blocks Write and Edit before mutation, while allowing a qualified correction', () => {
    const write = { ...call('Write', 'report.md'), arguments: { file_path: 'report.md', content: '✅ 双记录互证：纪要和逐字稿' } };
    expect(documentClaimPreflight(write, [user])).toEqual(['SOURCE_INDEPENDENCE_UNVERIFIED']);
    const edit = { ...call('Edit', 'report.md'), arguments: { file_path: 'report.md', new_string: '纪要和逐字稿同源，独立来源未经核验' } };
    expect(documentClaimPreflight(edit, [user])).toEqual([]);
  });
});

const descriptions = [
  '核验要求：至少两份独立来源，才能标记已验证。',
  '这些不是独立来源。', '尚未找到独立来源，结论待查。',
  '独立来源是指相互没有派生关系的原始记录。', '独立来源的核验方法如下。',
  '核验要求：空间主人和专家成员必须由目标空间查询核实。',
  '如果空间主人是 owner-fixture 且自动化不存在，应核对配置。',
  '谁是空间主人？', "These aren't independent sources.",
  '这些并非独立证据。', '纪要不构成独立来源。',
  '只有两份独立来源一致，才可以标为已验证。',
  '如果获得独立来源，应先核对原文。', '我们需要两份独立来源。',
  '两份独立来源是核验的必要条件。',
  '引用：“这些是独立来源。”', '报告声称：“这些是独立来源。”',
  '> 这些是独立来源。', '“这些是独立来源”',
  'These are not independent sources.', 'Only if independent sources agree can we verify it.',
  'Quote: "Confirmed by independent sources."',
  '空间主人待查。', '空间主人：尚未核实。',
  '空间专家成员待查，自动化配置未知。',
  '核验要求：空间主人必须从目标空间查询。',
  '空间主人：owner-fixture，尚未核实。',
];

describe('assertion modality and field scope regressions', () => {
  it.each(descriptions)('preserves a non-assertive explanation in both checks and Write: %s', (content) => {
    expect(checkDocumentEvidenceClaims(content, [])).toEqual([]);
    expect(documentClaimPreflight({ id: 'write', name: 'Write', arguments: { file_path: 'report.md', content } }, [])).toEqual([]);
    expect(boundDocumentEvidenceClaims(content, []).content).toBe(content);
  });
  it.each([
    '已找到两份独立来源，核验要求尚未完善。',
    '这些不是不独立来源。',
    '结论：“这些是独立来源”。',
    '引用：“这些是独立来源”，该说法已证实。',
    'These are independent sources.',
    '✅ 纪要与逐字稿互证，同源。',
  ])('retains an unsupported assertion negative control: %s', (content) => {
    expect(checkDocumentEvidenceClaims(content, [])).toContain('SOURCE_INDEPENDENCE_UNVERIFIED');
  });
  for (const punctuation of ['，', ',', '；', ';', '\n', '且', '，但', ' | ']) {
    it.each([
      ['空间主人：owner-fixture', '自动化配置待查', 'SPACE_OWNER_UNVERIFIED'],
      ['空间专家成员：expert-fixture', '空间主人待查', 'SPACE_MEMBERS_UNVERIFIED'],
      ['空间当前没有自动化', '成员待查', 'SPACE_AUTOMATIONS_UNVERIFIED'],
      ['空间主人待查', '自动化：没有', 'SPACE_AUTOMATIONS_UNVERIFIED'],
    ])(`keeps qualifications on their own field (${JSON.stringify(punctuation)}): %s`, (first, second, code) => {
      const content = first + punctuation + second;
      expect(checkDocumentEvidenceClaims(content, [])).toEqual([code]);
      expect(documentClaimPreflight({ id: 'edit', name: 'Edit', arguments: { file_path: 'report.md', new_string: content } }, [])).toEqual([code]);
    });
  }
  it('does not attach a preposed qualifier of another conjunct to owner', () => {
    expect(checkDocumentEvidenceClaims('空间主人：owner-fixture且待查的自动化配置', [])).toEqual(['SPACE_OWNER_UNVERIFIED']);
  });
  it('preserves valid text around a locally replaced assertion, including chunk-split negation', () => {
    const content = '附件已整理。核验要求：至少两份独立来源，才能标记已验证。\n空间主人：owner-fixture，自动化配置待查。\n这些不是独立来源。下一步核对原文。';
    const final = boundDocumentEvidenceClaims(content, []);
    expect(final.problems).toEqual(['SPACE_OWNER_UNVERIFIED']);
    expect(final.content).toContain('附件已整理。核验要求：至少两份独立来源，才能标记已验证。');
    expect(final.content).toContain('，自动化配置待查。\n这些不是独立来源。下一步核对原文。');
    expect(final.content).not.toContain('owner-fixture');
    const emitted: string[] = [];
    const stream = createDocumentEvidenceStream([], (text) => emitted.push(text));
    for (const char of content) stream.push(char);
    expect(emitted).toEqual([]);
    stream.finish(content);
    expect(emitted.join('')).toBe(final.content);
  });
});

// Exercise the actual inference callback wiring with a stub provider; no model, snapshot or DB I/O.
vi.mock('../../../src/host/telemetry/toolSchemaCache', () => ({ getToolSchemaCache: () => ({ store: () => true }) }));
vi.mock('../../../src/host/context/contextEventLedger', () => ({ getContextEventLedger: () => ({ upsertEvents: vi.fn() }) }));
vi.mock('../../../src/host/services/infra/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }, createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../../../src/host/services', () => ({
  getConfigService: () => ({ getApiKey: () => 'fixture', getSettings: () => ({ models: { providers: {} } }) }),
  getAuthService: () => ({ getCurrentUser: () => ({ isAdmin: false }) }),
  getLangfuseService: () => ({ startGenerationInSpan: vi.fn(), endGeneration: vi.fn() }),
}));
vi.mock('../../../src/host/tools/dispatch/toolDefinitions', () => ({
  getCoreToolDefinitions: () => [], getLoadedDeferredToolDefinitions: () => [], getAllToolDefinitions: () => [],
  withDesignCanvasTools: (tools: unknown) => tools, withoutGenericMediaToolsInDesign: (tools: unknown) => tools,
}));
vi.mock('../../../src/host/session/streamSnapshot', () => ({ createSnapshotHandler: () => () => undefined }));
vi.mock('../../../src/host/observability/posthogNode', () => ({ trackNode: vi.fn() }));
vi.mock('../../../src/host/model/adapters/aiSdkAdapter', () => ({ aiSdkSupportsProvider: () => false,
  inferenceViaAiSdk: () => { throw new Error('LIVE_PROVIDER_FORBIDDEN'); } }));

import { inference } from '../../../src/host/agent/runtime/contextAssembly/inference';
import type { ContextAssemblyCtx } from '../../../src/host/agent/runtime/contextAssembly/shared';
import type { StreamCallback } from '../../../src/host/model/types';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';

it.each([
  '核验要求：至少两份独立来源，才能标记已验证。',
  '这些不是独立来源。',
  '附件已整理。空间主人：owner-fixture，自动化配置待查。下一步核对原文。',
])('production inference emits the same bounded text after arbitrary chunk boundaries: %s', async (content) => {
  const onEvent = vi.fn();
  const router = {
    inference: vi.fn(async (_messages: unknown, _tools: unknown, _config: unknown, stream: StreamCallback) => {
      for (const char of content) stream({ type: 'text', content: char });
      expect(onEvent.mock.calls.filter(([event]) => event.type === 'message_delta' && event.data?.path === 'content')).toHaveLength(0);
      return { type: 'text', content, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
    }),
    detectRequiredCapabilities: () => [], getModelInfo: () => ({ supportsVision: true, supportsTool: true, capabilities: ['general'] }),
    getFallbackConfig: () => null, getVisionPreflightCandidates: () => [],
  };
  const runtime = {
    enableToolDeferredLoading: false, stats: RunStatsState.forTest({ traceId: 'trace-fixture' }),
    turn: TurnState.forTest({ currentIterationSpanId: 'span', currentTurnId: 'turn' }),
    sessionId: 'session-fixture', modelConfig: { provider: 'mock', model: 'test-model', apiKey: 'fixture' },
    modelRouter: router, onEvent, control: ControlState.forTest(), contextHealth: ContextHealthState.forTest(),
    messages: [], artifact: ArtifactState.forTest(),
  };
  const ctx = { runtime, inferenceRecovery: {}, taskProgress: { emitTaskProgress: vi.fn() },
    recordTokenUsage: vi.fn(), buildModelMessages: async () => [{ role: 'user', content: '整理说明' }],
    checkAndAutoCompress: vi.fn(),
  } as unknown as ContextAssemblyCtx;
  await inference(ctx);
  expect(router.inference).toHaveBeenCalledTimes(1);
  expect(runtime.turn.lastStreamedContent).toBe(boundDocumentEvidenceClaims(content, []).content);
  const emitted = onEvent.mock.calls.filter(([event]) => event.type === 'message_delta' && event.data.path === 'content');
  expect(emitted.map(([event]) => event.data.text).join('')).toBe(boundDocumentEvidenceClaims(content, []).content);
  expect(emitted.length).toBeGreaterThan(0);
  expect(JSON.stringify(emitted)).not.toContain('owner-fixture');
});

it('keeps handoff tails private and withholds an unfinished response', () => {
  const emitted: string[] = [];
  const stream = createDocumentEvidenceStream([], (text) => emitted.push(text));
  stream.push('空间主人：owner-fixture，');
  expect(emitted).toEqual([]);
  // No finish on an interrupted inference: no unbounded partial text reaches the consumer.
  const completed = createDocumentEvidenceStream([], (text) => emitted.push(text));
  completed.finish('附件已整理。<handoff-proposal>{"summary":"独立来源互证"}</handoff-proposal>');
  expect(emitted).toEqual(['附件已整理。']);
});
