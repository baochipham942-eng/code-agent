# ADR-033 Neo Tag 跨会话 Topic 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** @neo topic 可在任意会话续接：续接轮在当前会话跑（过程流式可见），Neo 携带 topic 历史轮正文，详情按会话聚合回溯。

**Architecture:** 全加法零破坏。① delta 落 `conversationId` 记录每轮会话归属；② `launchApprovedNeoWorkCard` 支持目标会话；③ topic 历史轮（用户原话+Neo 最终回复）物化注入 prompt 层（关键：现状 Neo 懂源会话是因为 run 跑在源会话里——prompt 层只有消息 ID 没有正文，跨会话必须注正文）；④ 续接 = 既有卡追加 revision → 自动批准 → launch 到当前会话；⑤ @neo 下拉挂最近活跃 topic 候选 → composer 续接 chip；⑥ 详情按会话集合聚合轮。

**Tech Stack:** TypeScript / Tauri host (better-sqlite3) / React + Zustand / vitest

**决策锚点（ADR-033，已拍板）：**
- D2 续接在**当前会话**跑；工作目录用当前会话自己的目录（不持久污染，不 setWorkingDirectory 改写目标会话；prompt 层告知 topic 原工作目录，Neo 需要时可自行读绝对路径）。
- 同卡在跑（approved/queued/working/waiting_for_user）时拒绝续接（CONFLICT，友好提示）。
- conversationIds 自动推导 = [当前会话, 源会话, ...历史 delta 会话]，无手动多选 UI。
- topic 历史段独立预算 4000 tokens，超出砍最老的轮，砍了记入 context audit。
- completed/failed 卡可续接（assertOpen 只挡 archived/cancelled，已核实 `neoWorkCardService.ts:193`）。
- neo-tag surface 文案沿用 ADR-032 现状（硬编码中文，i18n 已 deferred），与既有代码一致。

**已核实的既有事实（不要重查）：**
- `AgentRunOptions`（src/host/research/types.ts:167）**无** run 级 workingDirectory 字段 → 按 D2 决策用当前会话目录，不加 agent core 字段。
- delta 表：`neo_work_card_deltas`（schema.ts:1182），无 conversation_id 列；迁移模式 = `safeAlter(db, 'ALTER TABLE ... ADD COLUMN ...', logger)`（schema.ts:56 起有现成例子）。
- turnId 生成：renderer `createSourceTurnId`（tagClient.ts:47）= clientSourceMessageId 优先，否则 `neo-source-<uuid>`。
- host 不能 import renderer 代码 → `extractNeoTopicRounds` 必须先搬 shared。
- 服务测试 fixture：真 in-memory better-sqlite3（`vi.unmock('better-sqlite3')` + applySchema + seedProject），见 tests/unit/services/NeoWorkCardService.test.ts。
- runtime 测试 mock：`vi.mock('.../sessionManager')` 返回可控 getSession，见 tests/unit/services/neoTagRuntime.test.ts:27。
- 同 worktree 可能有其他会话并行提交：**每次 commit 前先 `git log --oneline -3` + `git status`**。

**File Structure（全量清单）：**

| 动作 | 文件 | 职责 |
|---|---|---|
| Modify | `src/shared/contract/tag.ts` | delta.conversationId、续接请求/结果契约、NeoTagRunContext.targetConversationId |
| Modify | `src/host/services/core/database/schema.ts` | deltas 表加 conversation_id 列（safeAlter） |
| Modify | `src/host/services/core/repositories/NeoWorkCardRepository.ts` | delta 读写带 conversationId |
| Modify | `src/host/services/project/neoWorkCardService.ts` | appendDelta 透传 conversationId |
| Create | `src/shared/neoTag/topicRounds.ts` | 轮提取/合并/会话集合推导（纯函数，host+renderer 共用） |
| Modify | `src/renderer/components/features/projectCollaboration/projectCollaborationData.ts` | 改为 re-export shared 实现 |
| Modify | `src/host/services/project/neoTagRuntimeService.ts` | launch 目标会话、topic 历史收集、delta 归属、续接编排 |
| Modify | `src/host/services/project/neoTagPromptLayer.ts` | Topic 历史段（正文+预算截断）+ topic 工作目录提示 |
| Modify | `src/host/ipc/tag.ipc.ts` | continueAndRun action |
| Modify | `src/renderer/services/tagClient.ts` | continueAndRun 客户端 |
| Modify | `src/renderer/stores/neoWorkCardStore.ts` | continueAndRun + continuationTarget chip 状态 |
| Modify | `src/renderer/components/features/chat/ChatInput/neoMentionRouting.ts` | topic 候选构造 |
| Modify | `src/renderer/components/features/chat/ChatInput/agentMentionRouting.ts` | 下拉合并 topic 候选 |
| Modify | `src/renderer/components/features/chat/ChatInput/useChatInputAgentCommand.ts` | 选中 topic → 设 chip |
| Create | `src/renderer/components/features/chat/ChatInput/NeoContinuationChip.tsx` | 续接 chip UI |
| Modify | `src/renderer/components/features/chat/ChatInput/index.tsx` | 挂 chip + 传 topic 候选 |
| Modify | `src/renderer/components/features/chat/neoTagSubmit.ts` | submitNeoTagContinuation |
| Modify | `src/renderer/components/ChatView.tsx` | 续接分支 |
| Modify | `src/renderer/components/features/projectCollaboration/ProjectCollaborationDetailPane.tsx` | 多会话聚合 + 轮级打开会话 + 追问入口 |

---

### Task 1: 契约 + schema + repo — delta 落会话归属

**Files:**
- Modify: `src/shared/contract/tag.ts`
- Modify: `src/host/services/core/database/schema.ts`
- Modify: `src/host/services/core/repositories/NeoWorkCardRepository.ts`
- Modify: `src/host/services/project/neoWorkCardService.ts`
- Test: `tests/unit/services/NeoWorkCardService.test.ts`（追加用例）

- [ ] **Step 1.1: 写失败测试**（追加到 NeoWorkCardService.test.ts 已有 describe 内，复用现成 fixture）

```ts
it('appendDelta persists conversationId and reads it back; legacy deltas stay undefined', () => {
  const created = service.createDraft(draft(), NOW);
  service.approveRevision({
    workCardId: created.workCard.id,
    reviewerUserId: 'user_reviewer',
  }, NOW + 1);

  const withConv = service.appendDelta({
    workCardId: created.workCard.id,
    runId: 'run_conv',
    completed: ['round in conv B'],
    conversationId: 'conv_B',
    markResultReview: false,
  }, NOW + 2);
  expect(withConv.conversationId).toBe('conv_B');

  const withoutConv = service.appendDelta({
    workCardId: created.workCard.id,
    runId: 'run_legacy',
    completed: ['legacy round'],
    markResultReview: false,
  }, NOW + 3);
  expect(withoutConv.conversationId).toBeUndefined();

  const detail = service.get(created.workCard.id);
  const stored = detail!.deltas.find((d) => d.runId === 'run_conv');
  expect(stored?.conversationId).toBe('conv_B');
  const legacy = detail!.deltas.find((d) => d.runId === 'run_legacy');
  expect(legacy?.conversationId).toBeUndefined();
});
```

- [ ] **Step 1.2: 跑测试确认失败**

Run: `npx vitest run tests/unit/services/NeoWorkCardService.test.ts -t 'conversationId'`
Expected: FAIL（`conversationId` 不在类型上 / 落库读回 undefined 但断言 'conv_B'）

- [ ] **Step 1.3: 契约加字段**（tag.ts）

`NeoWorkCardDelta` 接口（现 209 行起）`runId: string;` 之后加：

```ts
  /** 本轮实际发生的会话（跨会话续接后 ≠ sourceConversationId；老数据无此值时回退 sourceConversationId）。 */
  conversationId?: string;
```

`AppendNeoWorkCardDeltaInput`（现 334 行起）`runId: string;` 之后加：

```ts
  conversationId?: string;
```

- [ ] **Step 1.4: schema 迁移**（schema.ts）

在 `neo_work_card_deltas` CREATE TABLE 语句（1182 行）**之后**、紧跟该表相关语句处加（沿用文件里 safeAlter 既有写法）：

```ts
  safeAlter(db, `ALTER TABLE neo_work_card_deltas ADD COLUMN conversation_id TEXT`, logger);
```

注意：CREATE TABLE IF NOT EXISTS 的列清单**同步加** `conversation_id TEXT,`（放 `run_id TEXT NOT NULL,` 之后），保证新库/老库列集一致。

- [ ] **Step 1.5: repo 读写**（NeoWorkCardRepository.ts）

`rowToDelta`（105 行）`runId` 之后加：

```ts
    conversationId: row.conversation_id == null ? undefined : String(row.conversation_id),
```

`appendDelta`（429 行）INSERT 列清单 `run_id` 后加 `conversation_id`，VALUES 多一个 `?`，参数 `delta.runId,` 之后加：

```ts
        delta.conversationId ?? null,
```

- [ ] **Step 1.6: service 透传**（neoWorkCardService.ts appendDelta，delta 对象构造 `runId,` 之后）：

```ts
      conversationId: cleanString(input.conversationId) || undefined,
```

- [ ] **Step 1.7: 跑测试确认通过**

Run: `npx vitest run tests/unit/services/NeoWorkCardService.test.ts && npm run typecheck`
Expected: 全 PASS

- [ ] **Step 1.8: Commit**

```bash
git log --oneline -3 && git status --short   # 防并行会话
git add src/shared/contract/tag.ts src/host/services/core/database/schema.ts \
  src/host/services/core/repositories/NeoWorkCardRepository.ts \
  src/host/services/project/neoWorkCardService.ts tests/unit/services/NeoWorkCardService.test.ts
git commit -m "feat(neo-tag): delta 落会话归属 conversationId — 跨会话 topic 地基(ADR-033 T1)"
```

---

### Task 2: 轮提取搬 shared + 合并/会话集合推导

**Files:**
- Create: `src/shared/neoTag/topicRounds.ts`
- Modify: `src/renderer/components/features/projectCollaboration/projectCollaborationData.ts`（删本地实现改 re-export）
- Test: `tests/unit/shared/neoTopicRounds.test.ts`（新建）

- [ ] **Step 2.1: 写失败测试**（tests/unit/shared/neoTopicRounds.test.ts）

```ts
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract/message';
import {
  extractNeoTopicRounds,
  mergeTopicRounds,
  topicConversationIds,
} from '../../../src/shared/neoTag/topicRounds';

function msg(over: Partial<Message>): Message {
  return { id: 'm', role: 'user', content: 'x', timestamp: 0, ...over } as Message;
}

describe('shared topicRounds', () => {
  it('extractNeoTopicRounds annotates rounds with conversationId when provided', () => {
    const rounds = extractNeoTopicRounds([
      msg({ id: 'u1', role: 'user', content: '@neo 整理竞品', timestamp: 10, metadata: { neoTag: { workCardId: 'nwc_1' } } as Message['metadata'] }),
      msg({ id: 'a1', role: 'assistant', content: '第一轮回复', timestamp: 11 }),
    ], 'nwc_1', 'conv_A');
    expect(rounds).toHaveLength(1);
    expect(rounds[0].conversationId).toBe('conv_A');
    expect(rounds[0].reply).toBe('第一轮回复');
  });

  it('mergeTopicRounds interleaves by timestamp across conversations', () => {
    const merged = mergeTopicRounds([
      [{ request: 'r1', reply: 'a1', at: 10, conversationId: 'conv_A' }],
      [{ request: 'r2', reply: 'a2', at: 5, conversationId: 'conv_B' }],
    ]);
    expect(merged.map((r) => r.request)).toEqual(['r2', 'r1']);
  });

  it('topicConversationIds = source ∪ distinct delta conversations, source first, deduped', () => {
    const ids = topicConversationIds({
      workCard: { sourceConversationId: 'conv_A' },
      deltas: [
        { conversationId: 'conv_B' }, { conversationId: 'conv_A' },
        { conversationId: undefined }, { conversationId: 'conv_B' },
      ],
    } as never);
    expect(ids).toEqual(['conv_A', 'conv_B']);
  });
});
```

- [ ] **Step 2.2: 跑测试确认失败**

Run: `npx vitest run tests/unit/shared/neoTopicRounds.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 2.3: 实现 shared 模块**（src/shared/neoTag/topicRounds.ts，正文从 projectCollaborationData.ts:18-47 迁移 + 扩展）

```ts
import type { Message } from '../contract/message';
import type { NeoWorkCardDelta } from '../contract/tag';

// ============================================================================
// Topic 多轮回溯（host prompt 层与 renderer 详情共用的纯函数）：
// 真源是会话消息本身（用户消息带 metadata.neoTag.workCardId），不是 delta 记账。
// ============================================================================

export interface NeoTopicRound {
  /** 用户那轮的原话（含 @neo 前缀，如果有）。 */
  request: string;
  /** 该轮 Neo 的最终回复正文；还在跑/失败无回复时为 null。 */
  reply: string | null;
  /** 该轮发起时间。 */
  at: number;
  /** 该轮实际发生的会话（跨会话聚合时标注；单会话调用可省）。 */
  conversationId?: string;
}

export function extractNeoTopicRounds(
  messages: Message[],
  workCardId: string,
  conversationId?: string,
): NeoTopicRound[] {
  const rounds: NeoTopicRound[] = [];
  let current: NeoTopicRound | null = null;
  for (const message of messages) {
    if (message.role === 'user') {
      if (message.metadata?.neoTag?.workCardId === workCardId) {
        current = { request: message.content, reply: null, at: message.timestamp, conversationId };
        rounds.push(current);
      } else {
        // 任何别的用户消息（普通聊天/别的卡）都终结当前轮
        current = null;
      }
      continue;
    }
    if (current && message.role === 'assistant' && message.content?.trim()) {
      // 最终结论 = 该轮最后一条非空 assistant 正文
      current.reply = message.content;
    }
  }
  return rounds;
}

export function mergeTopicRounds(lists: NeoTopicRound[][]): NeoTopicRound[] {
  return lists.flat().sort((a, b) => a.at - b.at);
}

/** 卡参与过的会话集合：源会话在前，delta 归属去重在后（老 delta 无归属 → 自动回退源会话行为）。 */
export function topicConversationIds(detail: {
  workCard: { sourceConversationId: string };
  deltas: Array<Pick<NeoWorkCardDelta, 'conversationId'>>;
}): string[] {
  const ids = [detail.workCard.sourceConversationId];
  for (const delta of detail.deltas) {
    if (delta.conversationId && !ids.includes(delta.conversationId)) {
      ids.push(delta.conversationId);
    }
  }
  return ids;
}
```

- [ ] **Step 2.4: renderer 改 re-export**（projectCollaborationData.ts）

删掉本地 `NeoTopicRound` 接口 + `extractNeoTopicRounds` 实现（18-47 行），文件顶部改为：

```ts
export type { NeoTopicRound } from '@shared/neoTag/topicRounds';
export { extractNeoTopicRounds, mergeTopicRounds, topicConversationIds } from '@shared/neoTag/topicRounds';
```

（`@shared` alias 与文件里既有 `@shared/contract/tag` import 同款；`fetchConversationMessages` 等其余内容不动。）

- [ ] **Step 2.5: 跑测试 + 既有回归**

Run: `npx vitest run tests/unit/shared/neoTopicRounds.test.ts tests/renderer/components/projectCollaborationRounds.test.ts && npm run typecheck`
Expected: 全 PASS（老测试经 re-export 不用改 import）

- [ ] **Step 2.6: Commit**

```bash
git log --oneline -3 && git status --short
git add src/shared/neoTag/topicRounds.ts \
  src/renderer/components/features/projectCollaboration/projectCollaborationData.ts \
  tests/unit/shared/neoTopicRounds.test.ts
git commit -m "refactor(neo-tag): 轮提取搬 shared + 合并/会话集合推导(ADR-033 T2)"
```

---

### Task 3: runtime 支持目标会话 + delta 归属 + 工作目录护栏

**Files:**
- Modify: `src/host/services/project/neoTagRuntimeService.ts`
- Modify: `src/shared/contract/tag.ts`（NeoTagRunContext 加 targetConversationId）
- Test: `tests/unit/services/neoTagRuntime.test.ts`（追加用例）

- [ ] **Step 3.1: 写失败测试**（追加。沿用文件顶部的 sessionManager mock——先把 mock 升级为按 sessionId 区分返回，这是本 Task 测试的前置改造）：

把 mock 改成（替换 27-35 行）：

```ts
const sessionsById = new Map<string, { workingDirectory?: string; messages: Message[] }>();

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: vi.fn(async (sessionId: string) => ({
      id: sessionId,
      workingDirectory: sessionsById.get(sessionId)?.workingDirectory ?? sessionWorkingDirectory,
      messages: sessionsById.get(sessionId)?.messages ?? sessionMessages,
    })),
  }),
}));
```

（beforeEach 里 `sessionsById.clear()`；既有用例不受影响——未注册的 sessionId 走原全局兜底。）

新用例：

```ts
it('launches into target conversation: startTask/metadata/delta bind to the round conversation, working dir untouched', async () => {
  sessionsById.set('conv_B', { workingDirectory: '/repo/other', messages: [] });
  const startTask = vi.fn(async () => {});
  const setWorkingDirectory = vi.fn();
  const appendDelta = vi.fn();
  const service = fakeService({ appendDelta });  // 沿用文件里既有 fake service 构造方式

  await launchApprovedNeoWorkCard({
    workCardId: 'nwc_1',
    taskManager: { startTask, setWorkingDirectory, getSessionState: () => ({ status: 'idle' }) },
    service,
    target: { conversationId: 'conv_B', turnId: 'turn_round2' },
  });

  // 执行落在目标会话，锚点用轮 turnId
  expect(startTask).toHaveBeenCalledWith(
    'conv_B', expect.any(String), undefined, expect.any(Object),
    expect.objectContaining({ neoTag: expect.objectContaining({ sourceTurnId: 'turn_round2' }) }),
    'turn_round2',
  );
  // D2 护栏：跨会话续接不得持久改写目标会话工作目录
  expect(setWorkingDirectory).not.toHaveBeenCalled();
  // 每条 delta 都带轮会话归属
  for (const call of appendDelta.mock.calls) {
    expect(call[0].conversationId).toBe('conv_B');
  }
});

it('defaults to source conversation when no target given (existing behaviour + conversationId backfill)', async () => {
  const startTask = vi.fn(async () => {});
  const appendDelta = vi.fn();
  const service = fakeService({ appendDelta });
  await launchApprovedNeoWorkCard({
    workCardId: 'nwc_1',
    taskManager: { startTask, getSessionState: () => ({ status: 'idle' }) },
    service,
  });
  expect(startTask.mock.calls[0][0]).toBe('conv_1');
  for (const call of appendDelta.mock.calls) {
    expect(call[0].conversationId).toBe('conv_1');
  }
});
```

（`fakeService` 指该测试文件里已有的 service stub 构造 helper——按文件里现名对齐，没有就照现有用例内联 stub 的写法抄一份提出来。）

- [ ] **Step 3.2: 跑测试确认失败**

Run: `npx vitest run tests/unit/services/neoTagRuntime.test.ts -t 'target conversation'`
Expected: FAIL（launch 无 target 参数）

- [ ] **Step 3.3: 契约**（tag.ts `NeoTagRunContext`，`sourceTurnId: string;` 之后加）：

```ts
  /** 本轮实际执行的会话；缺省 = sourceConversationId（跨会话续接时不同）。 */
  targetConversationId?: string;
```

- [ ] **Step 3.4: runtime 实现**（neoTagRuntimeService.ts）

`LaunchApprovedNeoWorkCardInput` 加：

```ts
  /** 本轮落点：缺省回源会话（向后兼容）。跨会话续接时 = 当前会话 + 该轮 turnId。 */
  target?: { conversationId: string; turnId: string };
```

`launchApprovedNeoWorkCard` 体内，`const { workCard, approvedRevision } = detail;` 之后：

```ts
  const roundConversationId = input.target?.conversationId ?? workCard.sourceConversationId;
  const roundTurnId = input.target?.turnId ?? workCard.sourceTurnId;
  const isCrossConversation = roundConversationId !== workCard.sourceConversationId;
```

然后按下表逐处替换（该函数内所有出现点）：

| 原 | 改为 |
|---|---|
| `readSourceMessages(workCard.sourceConversationId)` | `readSourceMessages(roundConversationId)` |
| context 的 `sourceTurnId: workCard.sourceTurnId` | `sourceTurnId: roundTurnId`，并加 `targetConversationId: roundConversationId,` |
| 工作目录块（275-279 行 orchestrator/setWorkingDirectory 两行） | 整块包进 `if (source.workingDirectory && !isCrossConversation) { ... }`（D2 护栏：跨会话不 setWorkingDirectory） |
| metadata.neoTag 的 `sourceTurnId: workCard.sourceTurnId` | `sourceTurnId: roundTurnId` |
| `startTask(workCard.sourceConversationId, ...)` 与末参 `workCard.sourceTurnId` | `startTask(roundConversationId, ...)`、末参 `roundTurnId` |
| `waitForRuntimeState(input.taskManager, workCard.sourceConversationId)` | `waitForRuntimeState(input.taskManager, roundConversationId)` |
| 每个 `service.appendDelta({ workCardId, runId, ... })`（含 `appendFailureDelta` helper——给它加 `conversationId` 参数） | 都加 `conversationId: roundConversationId,` |

metadata.neoTag 的 `sourceConversationId` **保持** `workCard.sourceConversationId`（出处记录，锚点机制不动）。

- [ ] **Step 3.5: 跑测试确认通过**

Run: `npx vitest run tests/unit/services/neoTagRuntime.test.ts && npm run typecheck`
Expected: 全 PASS（含既有用例零回归）

- [ ] **Step 3.6: Commit**

```bash
git log --oneline -3 && git status --short
git add src/host/services/project/neoTagRuntimeService.ts src/shared/contract/tag.ts \
  tests/unit/services/neoTagRuntime.test.ts
git commit -m "feat(neo-tag): launch 支持目标会话 — 执行落当前会话+delta归属+工作目录护栏(ADR-033 T3)"
```

---

### Task 4: prompt 层 Topic 历史段（正文物化 + 4000 token 预算）

**Files:**
- Modify: `src/host/services/project/neoTagPromptLayer.ts`
- Modify: `src/host/services/project/neoTagRuntimeService.ts`（收集 rounds 传入）
- Test: `tests/unit/services/neoTagPromptLayer.topicHistory.test.ts`（新建）

- [ ] **Step 4.1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { buildNeoTagPromptLayer, TOPIC_HISTORY_MAX_TOKENS } from '../../../src/host/services/project/neoTagPromptLayer';
import type { NeoTopicRound } from '../../../src/shared/neoTag/topicRounds';
// runContext / revision 构造照抄 tests/unit/services/neoTagRuntime.test.ts 的 workCard/revision helper 形态

describe('prompt layer topic history', () => {
  it('materialises prior rounds (request + final reply) into the prompt', () => {
    const rounds: NeoTopicRound[] = [
      { request: '@neo 整理竞品报告', reply: '第一轮结论：……', at: 10, conversationId: 'conv_A' },
    ];
    const prompt = buildNeoTagPromptLayer({ runContext, revision, topicRounds: rounds });
    expect(prompt).toContain('Topic history');
    expect(prompt).toContain('整理竞品报告');
    expect(prompt).toContain('第一轮结论');
  });

  it('drops oldest rounds beyond the token budget and states the dropped count', () => {
    const big = 'x'.repeat(TOPIC_HISTORY_MAX_TOKENS * 4); // estimateTokens ≈ len/4，单轮即超预算
    const rounds: NeoTopicRound[] = [
      { request: '最老的轮', reply: big, at: 1, conversationId: 'conv_A' },
      { request: '最新的轮', reply: '短回复', at: 2, conversationId: 'conv_A' },
    ];
    const prompt = buildNeoTagPromptLayer({ runContext, revision, topicRounds: rounds });
    expect(prompt).toContain('最新的轮');
    expect(prompt).not.toContain('最老的轮');
    expect(prompt).toMatch(/1 earlier round\(s\) omitted/);
  });

  it('states the topic home workspace when running cross-conversation', () => {
    const prompt = buildNeoTagPromptLayer({
      runContext: { ...runContext, targetConversationId: 'conv_B' },
      revision,
      topicRounds: [],
      topicWorkspace: '/repo/project',
    });
    expect(prompt).toContain('/repo/project');
  });

  it('omits the section entirely when no rounds and not cross-conversation (legacy prompt unchanged)', () => {
    const prompt = buildNeoTagPromptLayer({ runContext, revision });
    expect(prompt).not.toContain('Topic history');
  });
});
```

- [ ] **Step 4.2: 跑测试确认失败**

Run: `npx vitest run tests/unit/services/neoTagPromptLayer.topicHistory.test.ts`
Expected: FAIL（无 TOPIC_HISTORY_MAX_TOKENS 导出 / 无 topicRounds 参数）

- [ ] **Step 4.3: 实现 prompt 层**（neoTagPromptLayer.ts）

```ts
import type { NeoTopicRound } from '../../../shared/neoTag/topicRounds';
import { estimateTokens } from '../../context/tokenOptimizer';

/** Topic 历史段独立预算（ADR-033 D3）：超出从最老的轮截断。 */
export const TOPIC_HISTORY_MAX_TOKENS = 4000;

function renderTopicHistory(rounds: NeoTopicRound[]): string[] {
  if (rounds.length === 0) return [];
  // 最新优先塞预算，输出仍按时间序
  const kept: NeoTopicRound[] = [];
  let used = 0;
  for (const round of [...rounds].reverse()) {
    const cost = estimateTokens(round.request) + estimateTokens(round.reply ?? '');
    if (kept.length > 0 && used + cost > TOPIC_HISTORY_MAX_TOKENS) break;
    kept.unshift(round);
    used += cost;
  }
  const dropped = rounds.length - kept.length;
  return [
    '',
    'Topic history (earlier rounds of this topic, possibly from other conversations):',
    ...kept.flatMap((round, index) => [
      `[round ${index + 1 + dropped}${round.conversationId ? ` @ ${round.conversationId}` : ''}]`,
      `user: ${round.request}`,
      `neo: ${round.reply ?? '(no final reply yet)'}`,
    ]),
    ...(dropped > 0 ? [`(${dropped} earlier round(s) omitted for token budget)`] : []),
  ];
}
```

`buildNeoTagPromptLayer` args 加 `topicRounds?: NeoTopicRound[]` 与 `topicWorkspace?: string`；在 `'Previous delta:'` 段**之前**插入：

```ts
    ...renderTopicHistory(topicRounds ?? []),
    ...(runContext.targetConversationId
      && runContext.targetConversationId !== runContext.sourceConversationId
      && topicWorkspace
      ? [
          '',
          `Topic home workspace: ${topicWorkspace}`,
          'This round runs in a different conversation/working directory; use absolute paths under the topic home workspace when the task refers to its files.',
        ]
      : []),
```

- [ ] **Step 4.4: runtime 收集 rounds**（neoTagRuntimeService.ts，`launchApprovedNeoWorkCard` 内 contextPack 构造后）

```ts
  // Topic 历史：从本轮之外的参与会话物化历史轮正文（Neo 懂源会话靠 run 在场；跨会话必须注正文）
  const historyConversationIds = Array.from(new Set([
    workCard.sourceConversationId,
    ...approvedRevision.readScope.conversationIds,
  ])).filter((id) => id && id !== roundConversationId);
  const topicRoundLists: NeoTopicRound[][] = [];
  let topicWorkspace: string | undefined;
  for (const conversationId of historyConversationIds) {
    const session = await getSessionManager().getSession(conversationId, 80);
    if (conversationId === workCard.sourceConversationId) {
      topicWorkspace = session?.workingDirectory;
    }
    topicRoundLists.push(extractNeoTopicRounds(session?.messages ?? [], workCard.id, conversationId));
  }
  const topicRounds = mergeTopicRounds(topicRoundLists);
```

（imports：`import { extractNeoTopicRounds, mergeTopicRounds, type NeoTopicRound } from '../../../shared/neoTag/topicRounds';`）

`buildNeoTagPromptLayer` 调用加 `topicRounds, topicWorkspace`。`summarizeContextAudit` 保持纯函数，改在调用处把 `topicRounds=${topicRounds.length}` 拼进 decisions 的 audit 串——直接给 `summarizeContextAudit` 加第二可选参数 `extra?: string` 并在返回 join 前 push，最省事：

```ts
function summarizeContextAudit(contextPack: NeoTagRunContext['contextPack'], topicRoundCount = 0): string {
  // …既有数组末尾追加：
  `topicRounds=${topicRoundCount}`,
```

（该函数 4 处调用点全部传 `topicRounds.length`；`appendFailureDelta` 经由参数传入的 audit 串自动带上。）

- [ ] **Step 4.5: 跑测试确认通过**

Run: `npx vitest run tests/unit/services/neoTagPromptLayer.topicHistory.test.ts tests/unit/services/neoTagRuntime.test.ts && npm run typecheck`
Expected: 全 PASS。注意 `parseContextAuditDecision`（renderer 解析 audit 串）是 `key=value` 宽松解析，新增键零破坏。

- [ ] **Step 4.6: Commit**

```bash
git log --oneline -3 && git status --short
git add src/host/services/project/neoTagPromptLayer.ts src/host/services/project/neoTagRuntimeService.ts \
  tests/unit/services/neoTagPromptLayer.topicHistory.test.ts
git commit -m "feat(neo-tag): prompt 层 Topic 历史段 — 跨会话正文物化+4000 token 预算(ADR-033 T4)"
```

---

### Task 5: 续接编排 continueAndRunNeoWorkCard（host）

**Files:**
- Modify: `src/host/services/project/neoTagRuntimeService.ts`
- Test: `tests/unit/services/neoTagContinuation.test.ts`（新建；fixture 用真 sqlite，照抄 NeoWorkCardService.test.ts 的 applySchema/seedProject/draft 搭法 + neoTagRuntime.test.ts 的 sessionManager mock）

- [ ] **Step 5.1: 写失败测试**

```ts
// 关键用例（fixture 铺垫按上述两个文件现成写法组合）：
describe('continueAndRunNeoWorkCard', () => {
  it('appends a follow-up revision, auto-approves, launches into the current conversation', async () => {
    // 先 createAndRun 一张卡到 completed（appendDelta markResultReview + acceptResult）
    const result = continueAndRunNeoWorkCard({
      workCardId: card.id,
      conversationId: 'conv_B',
      turnId: 'turn_round2',
      userText: '补上定价维度',
      requesterUserId: 'user_1',
      taskManager,
      service,
    });
    await result.run;
    const detail = service.get(card.id)!;
    expect(detail.revisions.length).toBeGreaterThanOrEqual(2);
    expect(detail.approvedRevision?.taskSummary).toBe('补上定价维度');
    // readScope.conversationIds 自动推导：当前会话 + 源会话（顺序不苛求，集合断言）
    expect(new Set(detail.approvedRevision!.readScope.conversationIds))
      .toEqual(new Set(['conv_B', 'conv_A']));
    expect(startTask.mock.calls[0][0]).toBe('conv_B');
    expect(detail.deltas.some((d) => d.conversationId === 'conv_B')).toBe(true);
  });

  it('rejects while the card is running (CONFLICT, friendly message)', () => {
    // 卡置 working
    expect(() => continueAndRunNeoWorkCard({ ...input })).toThrowError(/还在跑/);
  });

  it('rejects closed cards (archived/cancelled)', () => {
    expect(() => continueAndRunNeoWorkCard({ ...input })).toThrowError(NeoWorkCardServiceError);
  });

  it('completed cards are reopenable (assertOpen only blocks archived/cancelled)', async () => {
    // completed → continue → status 走 working 流
  });

  it('merges conversationIds across three conversations via prior delta ownership', async () => {
    // 先造一条 conversationId='conv_B' 的 delta，再从 conv_C 续接 → [conv_C, conv_A, conv_B] 全集
  });
});
```

- [ ] **Step 5.2: 跑测试确认失败**

Run: `npx vitest run tests/unit/services/neoTagContinuation.test.ts`
Expected: FAIL（函数不存在）

- [ ] **Step 5.3: 实现**（neoTagRuntimeService.ts 末尾追加）

```ts
const CONTINUATION_BLOCKED_STATUSES = new Set(['approved', 'queued', 'working', 'waiting_for_user']);

export interface ContinueAndRunNeoWorkCardInput {
  workCardId: string;
  /** 续接发生的会话 = 本轮执行落点（ADR-033 D2）。 */
  conversationId: string;
  /** 本轮用户消息 ID（renderer 本地补显与 host 落库同 ID 去重，机制同 sourceTurnId）。 */
  turnId: string;
  userText: string;
  requesterUserId: string;
  selectedArtifactIds?: string[];
  taskManager: NeoTagTaskManager;
  service?: NeoWorkCardService;
  now?: () => number;
  onWorkCardUpdated?: (workCardId: string, reason: NeoWorkCardUpdateReason) => void;
}

/**
 * @neo 跨会话续接（ADR-033）：既有 topic 追加一轮 —— 新 revision → 自动批准 → 在当前会话运行。
 * completed/failed 卡可续接重开；运行中拒绝（同卡双会话并发 fail-closed）。
 */
export function continueAndRunNeoWorkCard(
  input: ContinueAndRunNeoWorkCardInput,
): CreateAndRunNeoWorkCardResult {
  const service = input.service ?? getNeoWorkCardService();
  const now = input.now ?? Date.now;
  const detail = service.get(input.workCardId);
  if (!detail) throw new NeoWorkCardServiceError('NOT_FOUND', 'work card not found');
  if (CONTINUATION_BLOCKED_STATUSES.has(detail.workCard.status)) {
    throw new NeoWorkCardServiceError('CONFLICT', '这个 topic 还在跑，等这轮结束再续。');
  }
  const userText = input.userText.trim();
  if (!userText) throw new NeoWorkCardServiceError('INVALID_ARGS', '写一下要 Neo 接着做什么。');

  const base = detail.approvedRevision ?? detail.currentRevision;
  if (!base) throw new NeoWorkCardServiceError('INVALID_STATE', 'work card has no revision');
  const conversationIds = Array.from(new Set([
    input.conversationId,
    ...topicConversationIds(detail),
  ]));

  const updated = service.updateDraftRevision({
    workCardId: detail.workCard.id,
    updatedByUserId: input.requesterUserId,
    revision: {
      intent: base.intent,
      taskSummary: userText,
      readScope: {
        ...base.readScope,
        mode: 'selected_context',
        conversationIds,
        messageIds: [],
        artifactIds: input.selectedArtifactIds ?? [],
        notes: ['Follow-up round appended from another conversation (ADR-033).'],
      },
      writeScope: base.writeScope,
      modelIntent: base.modelIntent,
      memoryPlan: { mode: 'none', entries: [], notes: [] },
      expectedOutputs: base.expectedOutputs,
      risks: [],
      assumptions: [],
    },
  }, now());
  notifyWorkCardUpdated(input.onWorkCardUpdated, updated.workCard.id, 'draft_updated');

  service.approveRevision({
    workCardId: updated.workCard.id,
    revisionId: updated.revision.id,
    reviewerUserId: input.requesterUserId,
  }, now());
  notifyWorkCardUpdated(input.onWorkCardUpdated, updated.workCard.id, 'revision_approved');

  const run = launchApprovedNeoWorkCard({
    workCardId: updated.workCard.id,
    taskManager: input.taskManager,
    service,
    now,
    onWorkCardUpdated: input.onWorkCardUpdated,
    target: { conversationId: input.conversationId, turnId: input.turnId },
  });
  return { workCard: updated.workCard, revision: updated.revision, run };
}
```

（imports 补：`NeoWorkCardServiceError` 从 neoWorkCardService，`topicConversationIds` 从 shared/neoTag/topicRounds。）

- [ ] **Step 5.4: 跑测试确认通过**

Run: `npx vitest run tests/unit/services/neoTagContinuation.test.ts tests/unit/services/neoTagRuntime.test.ts tests/unit/services/NeoWorkCardService.test.ts && npm run typecheck`
Expected: 全 PASS

- [ ] **Step 5.5: Commit**

```bash
git log --oneline -3 && git status --short
git add src/host/services/project/neoTagRuntimeService.ts tests/unit/services/neoTagContinuation.test.ts
git commit -m "feat(neo-tag): continueAndRunNeoWorkCard — 同卡追加轮+自动批准+当前会话运行(ADR-033 T5)"
```

---

### Task 6: IPC + tagClient + store 打通续接链路

**Files:**
- Modify: `src/shared/contract/tag.ts`（续接请求/结果契约）
- Modify: `src/host/ipc/tag.ipc.ts`
- Modify: `src/renderer/services/tagClient.ts`
- Modify: `src/renderer/stores/neoWorkCardStore.ts`
- Test: `tests/renderer/components/chatView.neoTagSubmit.test.ts`（本 Task 只加 store/client 层用例；ChatView 分支在 T8）

- [ ] **Step 6.1: 契约**（tag.ts，放 `CreateNeoWorkCardDraftResult` 之后）

```ts
/** @neo 跨会话续接（ADR-033）：在任意会话把一轮追加到既有 topic。 */
export interface ContinueNeoWorkCardRequest {
  workCardId: string;
  /** 续接发生的会话 = 本轮执行落点。 */
  conversationId: string;
  userText: string;
  requesterUserId: string;
  selectedArtifactIds?: string[];
  /** renderer 本地补显的用户消息 ID；host 落库同 ID 去重（同 createAndRun 的 clientSourceMessageId 机制）。 */
  clientSourceMessageId?: string;
}

export interface ContinueNeoWorkCardResult {
  detail: NeoWorkCardDetail;
  /** 本轮用户消息锚点 ID。 */
  roundTurnId: string;
}
```

- [ ] **Step 6.2: IPC handler**（tag.ipc.ts，`case 'createAndRun'` 之后加）

```ts
        case 'continueAndRun': {
          // @neo 跨会话续接（ADR-033）：既有 topic 追加一轮，落点 = 发起续接的会话。
          const input = payload as (ContinueNeoWorkCardRequest & { turnId?: string }) | undefined;
          if (!input?.workCardId || !input.conversationId || !input.requesterUserId) {
            return invalid('workCardId, conversationId and requesterUserId are required');
          }
          const roundTurnId = input.clientSourceMessageId?.trim()
            || `neo-source-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
          const started = continueAndRunNeoWorkCard({
            workCardId: input.workCardId,
            conversationId: input.conversationId,
            turnId: roundTurnId,
            userText: input.userText ?? '',
            requesterUserId: input.requesterUserId,
            selectedArtifactIds: input.selectedArtifactIds,
            taskManager: getTaskManager(),
            service,
            onWorkCardUpdated: (workCardId, reason) => emitWorkCardUpdated(service, workCardId, reason),
          });
          started.run.catch((error) => {
            logger.error('Failed to run @neo follow-up round', error);
          });
          return {
            success: true,
            data: { workCard: started.workCard, revision: started.revision, roundTurnId },
          };
        }
```

（imports 补：`randomUUID` from 'crypto'、`continueAndRunNeoWorkCard`、`ContinueNeoWorkCardRequest` 类型。）

- [ ] **Step 6.3: tagClient**（createAndRun 之后加）

```ts
  // @neo 跨会话续接：既有 topic 追加一轮，落点 = 当前会话（ADR-033）。
  async continueAndRun(input: ContinueNeoWorkCardRequest): Promise<ContinueNeoWorkCardResult> {
    const result = await invokeTag<{
      workCard: NeoWorkCardWithCurrentRevision['workCard'];
      revision: NeoWorkCardWithCurrentRevision['revision'];
      roundTurnId: string;
    }>('continueAndRun', input);
    return {
      detail: toDetail({ workCard: result.workCard, revision: result.revision }),
      roundTurnId: result.roundTurnId,
    };
  },
```

- [ ] **Step 6.4: store**（neoWorkCardStore.ts）

state 加：

```ts
  /** @neo 续接 chip：从 mention 下拉选中既有 topic 后挂在 composer 上（ADR-033 D1）。 */
  continuationTarget: { workCardId: string; title: string } | null;
  setContinuationTarget: (target: { workCardId: string; title: string } | null) => void;
  continueAndRun: (input: ContinueNeoWorkCardRequest) => Promise<ContinueNeoWorkCardResult>;
```

实现（createAndRun 旁边，upsert detail 的写法照抄它）：

```ts
    continuationTarget: null,
    setContinuationTarget: (target) => set({ continuationTarget: target }),
    continueAndRun: async (input) => {
      const result = await tagClient.continueAndRun(input);
      set((state) => ({ detailsById: upsert(state.detailsById, result.detail) }));
      return result;
    },
```

- [ ] **Step 6.5: typecheck + 既有测试回归**

Run: `npm run typecheck && npx vitest run tests/renderer/components/chatView.neoTagSubmit.test.ts`
Expected: PASS（本 Task 是接线层，行为断言集中在 T5/T8 两端；IPC 参数校验分支由 typecheck+T8 mock 覆盖）

- [ ] **Step 6.6: Commit**

```bash
git log --oneline -3 && git status --short
git add src/shared/contract/tag.ts src/host/ipc/tag.ipc.ts src/renderer/services/tagClient.ts \
  src/renderer/stores/neoWorkCardStore.ts
git commit -m "feat(neo-tag): continueAndRun IPC/client/store 链路+续接chip状态(ADR-033 T6)"
```

---

### Task 7: @neo 下拉 topic 候选 + 续接 chip UI

**Files:**
- Modify: `src/renderer/components/features/chat/ChatInput/neoMentionRouting.ts`
- Modify: `src/renderer/components/features/chat/ChatInput/agentMentionRouting.ts`
- Modify: `src/renderer/components/features/chat/ChatInput/useChatInputAgentCommand.ts`
- Create: `src/renderer/components/features/chat/ChatInput/NeoContinuationChip.tsx`
- Modify: `src/renderer/components/features/chat/ChatInput/index.tsx`
- Test: `tests/renderer/components/chatInput.agentMentionRouting.test.ts`（追加）

- [ ] **Step 7.1: 写失败测试**（追加到 chatInput.agentMentionRouting.test.ts）

```ts
import { buildNeoTopicMentionCandidates, NEO_TOPIC_MENTION_PREFIX } from
  '../../../src/renderer/components/features/chat/ChatInput/neoMentionRouting';

describe('neo topic mention candidates', () => {
  const topics = [
    { workCardId: 'nwc_1', title: '整理竞品报告', status: 'completed' as const, updatedAt: 30 },
    { workCardId: 'nwc_2', title: '梳理定价', status: 'in_result_review' as const, updatedAt: 20 },
    { workCardId: 'nwc_3', title: '已归档的活', status: 'archived' as const, updatedAt: 99 },
  ];

  it('builds candidates from active topics, newest first, closed excluded', () => {
    const candidates = buildNeoTopicMentionCandidates(topics);
    expect(candidates.map((c) => c.id)).toEqual([
      `${NEO_TOPIC_MENTION_PREFIX}nwc_1`,
      `${NEO_TOPIC_MENTION_PREFIX}nwc_2`,
    ]);
    expect(candidates[0].role).toContain('整理竞品报告');
  });

  it('surfaces topic candidates in the @ autocomplete right after the Neo entry', () => {
    const autocomplete = buildAgentMentionAutocomplete('@neo', [], buildNeoTopicMentionCandidates(topics));
    expect(autocomplete?.matches[0].id).toBe(NEO_TAG_MENTION_AGENT.id);
    expect(autocomplete?.matches[1].id).toBe(`${NEO_TOPIC_MENTION_PREFIX}nwc_1`);
  });

  it('keeps topic candidates out when query does not summon Neo', () => {
    const autocomplete = buildAgentMentionAutocomplete('@src/foo', [], buildNeoTopicMentionCandidates(topics));
    expect(autocomplete?.matches.some((m) => m.id.startsWith(NEO_TOPIC_MENTION_PREFIX)) ?? false).toBe(false);
  });
});
```

（`buildAgentMentionAutocomplete` 的现有形参名以文件为准——第三参新增 `neoTopicCandidates?: MentionRoutingAgent[]`，既有调用零改动。若既有测试对该函数已有调用写法，抄它的。）

- [ ] **Step 7.2: 跑测试确认失败**

Run: `npx vitest run tests/renderer/components/chatInput.agentMentionRouting.test.ts -t 'topic'`
Expected: FAIL

- [ ] **Step 7.3: 候选构造**（neoMentionRouting.ts 追加）

```ts
export const NEO_TOPIC_MENTION_PREFIX = '__neo_topic__:';

const CLOSED_TOPIC_STATUSES = new Set(['cancelled', 'archived']);
const MAX_TOPIC_CANDIDATES = 5;

export interface NeoTopicMentionSource {
  workCardId: string;
  title: string;
  status: string;
  updatedAt: number;
}

/** @neo 下拉的「续接既有 topic」候选：最近活跃前 5，已结束的不进（ADR-033 D1）。 */
export function buildNeoTopicMentionCandidates(
  topics: NeoTopicMentionSource[],
): Array<MentionRoutingAgent & { role: string }> {
  return topics
    .filter((topic) => !CLOSED_TOPIC_STATUSES.has(topic.status))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_TOPIC_CANDIDATES)
    .map((topic) => ({
      id: `${NEO_TOPIC_MENTION_PREFIX}${topic.workCardId}`,
      name: 'Neo',
      role: `续接 · ${topic.title.length > 24 ? `${topic.title.slice(0, 23)}…` : topic.title}`,
    }));
}
```

- [ ] **Step 7.4: 下拉合并**（agentMentionRouting.ts，`withNeo` 处改为）

```ts
  const withNeo = shouldSuggestNeoMention(query)
    ? [NEO_TAG_MENTION_AGENT, ...(neoTopicCandidates ?? []), ...matches]
    : matches;
```

（函数签名加第三可选参 `neoTopicCandidates?: MentionRoutingAgent[]`。）

- [ ] **Step 7.5: 选中处理**（useChatInputAgentCommand.ts `handleAgentMentionSelect`）

```ts
  const handleAgentMentionSelect = useCallback((agentId: string) => {
    if (agentId.startsWith(NEO_TOPIC_MENTION_PREFIX)) {
      const workCardId = agentId.slice(NEO_TOPIC_MENTION_PREFIX.length);
      const detail = useNeoWorkCardStore.getState().detailsById[workCardId];
      if (detail) {
        useNeoWorkCardStore.getState().setContinuationTarget({
          workCardId,
          title: detail.workCard.title,
        });
      }
      setValue((prev) => applyAgentMentionSuggestion(prev, NEO_TAG_MENTION_AGENT));
      setDismissedAgentAutocompleteValue(null);
      inputAreaRef.current?.focus();
      return;
    }
    // …既有 NEO_TAG_MENTION_AGENT / swarm 分支保持不动
```

topic 候选数据源：本 hook（或其调用方 index.tsx）里从 store 取：

```ts
  const detailsById = useNeoWorkCardStore((state) => state.detailsById);
  const loadAll = useNeoWorkCardStore((state) => state.loadAll);
  // 下拉首次可见时懒加载一次全局目录（listAll 已有，Neo 协同同款）
  useEffect(() => {
    if (agentMentionAutocomplete && !loadedRef.current) {
      loadedRef.current = true;
      void loadAll();
    }
  }, [agentMentionAutocomplete, loadAll]);
  const neoTopicCandidates = useMemo(
    () => buildNeoTopicMentionCandidates(Object.values(detailsById).map((detail) => ({
      workCardId: detail.workCard.id,
      title: detail.workCard.title,
      status: detail.workCard.status,
      updatedAt: detail.workCard.updatedAt,
    }))),
    [detailsById],
  );
```

`neoTopicCandidates` 传给 `buildAgentMentionAutocomplete` 调用点（就在本 hook 内，grep `buildAgentMentionAutocomplete(` 对齐现有实参）。

- [ ] **Step 7.6: chip 组件**（NeoContinuationChip.tsx 新建；样式对齐同目录 `AgentChip.tsx` 的现有观感）

```tsx
import { Sparkles, X } from 'lucide-react';
import { useNeoWorkCardStore } from '../../../../stores/neoWorkCardStore';

/** @neo 续接 chip：composer 态标记「这条消息续接哪个 topic」，可移除（ADR-033 D1）。 */
export function NeoContinuationChip() {
  const target = useNeoWorkCardStore((state) => state.continuationTarget);
  const setTarget = useNeoWorkCardStore((state) => state.setContinuationTarget);
  if (!target) return null;
  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400">
      <Sparkles className="h-3 w-3" />
      <span className="max-w-[220px] truncate">续接 · {target.title}</span>
      <button
        type="button"
        aria-label="移除续接"
        className="rounded-full p-0.5 hover:bg-emerald-500/20"
        onClick={() => setTarget(null)}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
```

index.tsx：在 `AttachmentBar` 渲染位置旁挂 `<NeoContinuationChip />`（同一容器行，attachments 与 chip 并排）。

- [ ] **Step 7.7: 跑测试确认通过**

Run: `npx vitest run tests/renderer/components/chatInput.agentMentionRouting.test.ts && npm run typecheck`
Expected: 全 PASS

- [ ] **Step 7.8: Commit**

```bash
git log --oneline -3 && git status --short
git add src/renderer/components/features/chat/ChatInput/
git commit -m "feat(neo-tag): @neo 下拉最近活跃 topic 候选+续接 chip(ADR-033 T7)"
```

---

### Task 8: ChatView 续接提交分支

**Files:**
- Modify: `src/renderer/components/features/chat/neoTagSubmit.ts`
- Modify: `src/renderer/components/ChatView.tsx`
- Test: `tests/renderer/components/chatView.neoTagSubmit.test.ts`（追加）

- [ ] **Step 8.1: 写失败测试**（照该文件既有 mock 形态追加）

```ts
describe('submitNeoTagContinuation', () => {
  it('strips optional @neo prefix and calls runContinuation with the round payload', async () => {
    const runContinuation = vi.fn(async () => ({
      detail: fakeDetail, roundTurnId: 'turn_round2',
    }));
    const result = await submitNeoTagContinuation({
      envelope: envelope('@neo 补上定价维度'),
      conversationId: 'conv_B',
      continuationTarget: { workCardId: 'nwc_1', title: '整理竞品报告' },
      requesterUserId: 'user_1',
      runContinuation,
    });
    expect(runContinuation).toHaveBeenCalledWith(expect.objectContaining({
      workCardId: 'nwc_1',
      conversationId: 'conv_B',
      userText: '补上定价维度',
    }));
    expect(result?.roundTurnId).toBe('turn_round2');
  });

  it('works without @neo prefix — the chip itself is the intent', async () => {
    const runContinuation = vi.fn(async () => ({ detail: fakeDetail, roundTurnId: 't' }));
    await submitNeoTagContinuation({
      envelope: envelope('补上定价维度'),
      conversationId: 'conv_B',
      continuationTarget: { workCardId: 'nwc_1', title: 'x' },
      requesterUserId: 'user_1',
      runContinuation,
    });
    expect(runContinuation.mock.calls[0][0].userText).toBe('补上定价维度');
  });

  it('rejects empty text with a friendly error', async () => {
    await expect(submitNeoTagContinuation({
      envelope: envelope('@neo   '),
      conversationId: 'conv_B',
      continuationTarget: { workCardId: 'nwc_1', title: 'x' },
      requesterUserId: 'user_1',
      runContinuation: vi.fn(),
    })).rejects.toThrow();
  });

  it('buildNeoTagContinuationMessage anchors the local user message to roundTurnId + workCardId', () => {
    const message = buildNeoTagContinuationMessage({
      envelope: envelope('@neo 补上定价维度'),
      conversationId: 'conv_B',
      workCardId: 'nwc_1',
      roundTurnId: 'turn_round2',
    });
    expect(message.id).toBe('turn_round2');
    expect(message.metadata?.neoTag?.workCardId).toBe('nwc_1');
  });
});
```

- [ ] **Step 8.2: 跑测试确认失败**

Run: `npx vitest run tests/renderer/components/chatView.neoTagSubmit.test.ts -t 'Continuation'`
Expected: FAIL

- [ ] **Step 8.3: 实现 submit 助手**（neoTagSubmit.ts 追加）

```ts
import type {
  ContinueNeoWorkCardRequest,
  ContinueNeoWorkCardResult,
} from '@shared/contract/tag';

export interface SubmitNeoTagContinuationParams {
  envelope: ConversationEnvelope;
  conversationId: string;
  continuationTarget: { workCardId: string; title: string };
  requesterUserId: string;
  runContinuation: (input: ContinueNeoWorkCardRequest) => Promise<ContinueNeoWorkCardResult>;
}

/** @neo 续接（ADR-033）：chip 即意图，@neo 前缀可有可无；正文空则报人话错误。 */
export async function submitNeoTagContinuation(
  params: SubmitNeoTagContinuationParams,
): Promise<ContinueNeoWorkCardResult> {
  const parsed = parseLeadingNeoTagInvocation(params.envelope.content);
  const userText = (parsed ? parsed.userText : params.envelope.content).trim();
  if (!userText) {
    throw new Error('写一下要 Neo 接着做什么。');
  }
  return params.runContinuation({
    workCardId: params.continuationTarget.workCardId,
    conversationId: params.conversationId,
    userText,
    requesterUserId: params.requesterUserId,
    selectedArtifactIds: params.envelope.attachments?.map((attachment) => attachment.id) ?? [],
    clientSourceMessageId: params.envelope.clientMessageId,
  });
}

/** 续接轮本地补显：机制同 buildNeoTagSourceMessage（同 ID 落库去重）。 */
export function buildNeoTagContinuationMessage(params: {
  envelope: ConversationEnvelope;
  conversationId: string;
  workCardId: string;
  roundTurnId: string;
  timestamp?: number;
}): Message {
  return {
    id: params.roundTurnId,
    role: 'user',
    content: params.envelope.content,
    timestamp: params.timestamp ?? Date.now(),
    attachments: params.envelope.attachments,
    metadata: {
      neoTag: {
        workCardId: params.workCardId,
        sourceConversationId: params.conversationId,
        sourceTurnId: params.roundTurnId,
      },
    },
  };
}
```

- [ ] **Step 8.4: ChatView 接线**（handleSendEnvelope 内，`submitNeoTagDraft` 调用**之前**加续接分支）

```ts
        const continuationTarget = useNeoWorkCardStore.getState().continuationTarget;
        if (continuationTarget) {
          const continuation = await submitNeoTagContinuation({
            envelope,
            conversationId: currentSessionId,
            continuationTarget,
            requesterUserId: authUser?.id ?? 'local-user',
            runContinuation: useNeoWorkCardStore.getState().continueAndRun,
          });
          const roundMessage = buildNeoTagContinuationMessage({
            envelope,
            conversationId: currentSessionId,
            workCardId: continuationTarget.workCardId,
            roundTurnId: continuation.roundTurnId,
          });
          if (!messagesRef.current.some((message) => message.id === roundMessage.id)) {
            useSessionStore.getState().addMessage(roundMessage);
          }
          useNeoWorkCardStore.getState().setContinuationTarget(null);
          return true;
        }
```

catch 分支已有 `toast.error(...)` 兜底——host CONFLICT（「这个 topic 还在跑…」）的人话直接透出，chip **不**清（用户改完再发）。注意：此分支放进已有的 try 内，失败路径 return false 与既有行为一致。

- [ ] **Step 8.5: 跑测试确认通过**

Run: `npx vitest run tests/renderer/components/chatView.neoTagSubmit.test.ts && npm run typecheck`
Expected: 全 PASS

- [ ] **Step 8.6: Commit**

```bash
git log --oneline -3 && git status --short
git add src/renderer/components/features/chat/neoTagSubmit.ts src/renderer/components/ChatView.tsx \
  tests/renderer/components/chatView.neoTagSubmit.test.ts
git commit -m "feat(neo-tag): ChatView 续接分支 — chip 即意图+本地补显同ID去重(ADR-033 T8)"
```

---

### Task 9: 详情多会话聚合 + 轮级打开会话 + 追问入口

**Files:**
- Modify: `src/renderer/components/features/projectCollaboration/ProjectCollaborationDetailPane.tsx`
- Test: `tests/renderer/components/projectCollaborationRounds.test.ts`（追加聚合用例）
- Test: `tests/renderer/components/projectCollaborationPanel.test.tsx`（追加轮级跳转/追问用例，按该文件既有 render 方式）

- [ ] **Step 9.1: 写失败测试**（projectCollaborationRounds.test.ts 追加纯函数级聚合用例）

```ts
it('aggregates rounds across the topic conversation set, ordered by time, each tagged with its conversation', () => {
  const roundsA = extractNeoTopicRounds(messagesInConvA, 'nwc_1', 'conv_A'); // 轮1 at=10
  const roundsB = extractNeoTopicRounds(messagesInConvB, 'nwc_1', 'conv_B'); // 轮2 at=20
  const merged = mergeTopicRounds([roundsA, roundsB]);
  expect(merged.map((r) => r.conversationId)).toEqual(['conv_A', 'conv_B']);
});
```

Panel 级（projectCollaborationPanel.test.tsx，mock `window.domainAPI` 的 `getMessages` 按 sessionId 分流）：

```ts
it('detail pane fetches every topic conversation and offers per-round 打开会话', async () => {
  // detail.deltas 含 conversationId conv_B → 断言 getMessages 被 conv_A 与 conv_B 各调一次，
  // 且每轮渲染出「打开会话」按钮，点击回调收到该轮的 conversationId
});
it('detail pane follow-up input sends continueAndRun targeting the latest round conversation', async () => {
  // 输入追问 → store.continueAndRun 收到 conversationId = 最近一轮所在会话（无轮回退 source）
});
```

- [ ] **Step 9.2: 跑测试确认失败**

Run: `npx vitest run tests/renderer/components/projectCollaborationRounds.test.ts tests/renderer/components/projectCollaborationPanel.test.tsx`
Expected: 聚合/轮级按钮/追问用例 FAIL

- [ ] **Step 9.3: DetailPane 实现**

数据层（替换现单会话 effect，95-107 行一带）：

```ts
  const conversationIds = useMemo(
    () => (detail ? topicConversationIds(detail) : []),
    [detail, detailUpdatedAt],
  );

  useEffect(() => {
    if (conversationIds.length === 0) return;
    let cancelled = false;
    void Promise.all(conversationIds.map(async (conversationId) => ({
      conversationId,
      messages: await fetchConversationMessages(conversationId), // 已 fail-safe：单会话失败返回空
    }))).then((buckets) => {
      if (cancelled || !detail) return;
      setRounds(mergeTopicRounds(
        buckets.map((bucket) => extractNeoTopicRounds(bucket.messages, detail.workCard.id, bucket.conversationId)),
      ));
    });
    return () => { cancelled = true; };
  }, [conversationIds.join('|'), detail?.workCard.id, detailUpdatedAt]);
```

轮渲染：每轮尾部加轮级跳转（`onOpenConversation` 已是现成 prop）：

```tsx
  {onOpenConversation && round.conversationId && (
    <button type="button" className="…同现有打开会话按钮样式…"
      onClick={() => onOpenConversation(round.conversationId!)}>
      <MessageSquare className="h-3 w-3" />打开会话
    </button>
  )}
```

头部原「打开会话」按钮保留（跳源会话）。

追问入口（详情底部）：

```tsx
  const continueFromDetail = async () => {
    const text = followUpText.trim();
    if (!text || !detail) return;
    const targetConversationId = rounds.at(-1)?.conversationId ?? detail.workCard.sourceConversationId;
    try {
      await useNeoWorkCardStore.getState().continueAndRun({
        workCardId: detail.workCard.id,
        conversationId: targetConversationId,
        userText: text,
        requesterUserId: currentUser?.id ?? 'local-user',
      });
      setFollowUpText('');
      setSourceMessages(undefined); // 触发重拉聚合
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : String(error));
    }
  };
```

UI = 一行输入框 + 发送按钮 + 错误行（样式对齐面板既有输入控件；文案硬编码中文与 surface 现状一致）。落点规则注释写明：**追问落最近一轮的会话（无轮回退源会话）**——详情页没有"当前会话"语境，最近轮会话是 topic 最新上下文所在。

- [ ] **Step 9.4: 跑测试确认通过**

Run: `npx vitest run tests/renderer/components/projectCollaborationRounds.test.ts tests/renderer/components/projectCollaborationPanel.test.tsx && npm run typecheck`
Expected: 全 PASS

- [ ] **Step 9.5: Commit**

```bash
git log --oneline -3 && git status --short
git add src/renderer/components/features/projectCollaboration/ tests/renderer/components/
git commit -m "feat(neo-tag): topic 详情多会话聚合+轮级打开会话+追问入口(ADR-033 T9)"
```

---

### Task 10: 全量回归 + Dev 包 dogfood（跨会话真验证）

**Files:** 无源码改动（发现 bug 则回相应 Task 补测试再修）

- [ ] **Step 10.1: 全量门**

Run: `npm run typecheck && npx vitest run tests/unit tests/renderer`
Expected: 全绿（基线 155+ 本计划新增用例）

- [ ] **Step 10.2: 打包**（worktree 内；坑已固化）

```bash
# sidecar 从主树拷（rtk/uv/system-audio-capture/vision-*/Computer Use.app）
cp -R /Users/linchen/Downloads/ai/code-agent/scripts/rtk /Users/linchen/Downloads/ai/code-agent/scripts/uv \
  /Users/linchen/Downloads/ai/code-agent/scripts/system-audio-capture scripts/ 2>/dev/null || true
export CARGO_TARGET_DIR=/Users/linchen/Downloads/ai/code-agent/src-tauri/target
npm run build:web && npm run build:renderer && cargo tauri build --config src-tauri/tauri.dev.conf.json
```

- [ ] **Step 10.3: 装包（需要林晨）**

```bash
pgrep -fl "Agent Neo"   # Dev 在跑 → 请林晨 Cmd+Q
# 请林晨执行：bash /Users/linchen/Downloads/ai/code-agent/scripts/tauri-install-dev.sh
rm -rf ~/.code-agent-dev/renderer-cache/active
```

- [ ] **Step 10.4: dogfood 清单**（headless 驱动 http://127.0.0.1:8181，playwright-core 从主树 node_modules 绝对路径 import；模型用 APP 当前默认，分钱级成本）

1. 会话 A：`@neo <小任务>` → 流式回复正常、Neo 身份标识在（回归）。
2. 新建会话 B：输入 `@neo` → 下拉出现「续接 · <topic>」候选 → 选中出 chip → 发追问。
3. 断言：回复在**会话 B** 流式出现；回复内容引用了 A 轮上下文（Neo 没失忆）。
4. Neo 协同目录 → 该 topic 详情：两轮聚合展示、各带「打开会话」、分别跳 A/B。
5. topic 在跑时从第三会话续接 → 得到「这个 topic 还在跑」提示（fail-closed）。
6. 老 topic（升级前建的）详情正常显示（delta 无 conversationId 的回退路径）。
7. 详情页追问入口发一条 → 落最近一轮会话。

- [ ] **Step 10.5: 收尾 commit（如 dogfood 有修补）+ 汇报**

汇报证据口径：测试通过数、dogfood 七项逐条结论、成本；不贴 diff。分支停在 feat/neo-tag-lightweight 本地，push/合并等林晨拍板。

---

## Self-Review 结论（已跑）

- **Spec 覆盖**：D1→T7（下拉+chip）+T9（详情追问）；D2→T3（target+wd 护栏）+T5（并发拒绝）+T6/T8（链路）；D3→T4（正文物化+预算+audit）+T5（conversationIds 自动推导）；D4→T2（shared 纯函数）+T9（聚合+轮级跳转）；「不做的事」无对应 Task ✓。
- **类型一致性**：`conversationId`（delta）/ `target:{conversationId,turnId}`（launch）/ `ContinueNeoWorkCardRequest/Result`（契约）/ `roundTurnId`（IPC 结果）/ `continuationTarget`（store）在各 Task 间已对齐；`topicConversationIds` T2 定义、T5/T9 消费。
- **占位符扫描**：测试代码中 fixture 铺垫引用既有文件的 helper（明确指名 NeoWorkCardService.test.ts / neoTagRuntime.test.ts 的现成构造），非 TBD。
