// ============================================================================
// LearningPipeline LLM 复盘链 — 真穿透集成测试（Codex 审计 MED：补真 quickTask 链路）
// 只 mock quick model（fake 返回）+ telemetry，不 mock conversationReview / skillDraftQueue / 安全闸，
// 证明 runSessionEndLearning → 真 reviewConversationForSkill → quickTask → 真 enqueue → 事件 → 真 confirm 落盘
// 整条链活着穿透，而不是各段单测各自 mock。
//
// 这是【单元集成测试】，不是 provider 级 e2e。仍未覆盖（需真 app/真模型）：
// 真实 quick model 配置与 fetch、真实 timeout race、SSE→renderer 事件桥、IPC confirm handler。
// 那部分留给真模型 E2E（起 app 跑一轮）。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../../src/main/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
  getSkillsDir: () => ({
    user: {
      new: path.join(mockConfigDir.dir, 'skills'),
      legacy: path.join(mockConfigDir.dir, 'skills-legacy'),
    },
  }),
}));

vi.mock('../../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// telemetry 无工具调用：迫使只走 LLM 复盘链
vi.mock('../../../../src/main/telemetry/telemetryStorage', () => ({
  getTelemetryStorage: () => ({ getToolCallsBySession: () => [] }),
}));

// fake quick model：返回一份合法的 class-level skill JSON
const quickMocks = vi.hoisted(() => ({
  quickTask: vi.fn(async () => ({
    success: true,
    content: JSON.stringify({
      shouldCreate: true,
      signal: 'remember_request',
      name: 'deploy-tauri-macos',
      description: '部署 Tauri 桌面应用的标准流程',
      body: '## 要点\n- 先 `npm run typecheck`\n- 用 `scripts/tauri-install.sh` 安装',
    }),
  })),
}));
vi.mock('../../../../src/main/model/quickModel', () => ({ quickTask: quickMocks.quickTask }));
vi.mock('../../../../src/main/services/infra/timeoutController', () => ({
  withTimeout: <T>(p: Promise<T>) => p,
}));

import { LearningPipeline } from '../../../../src/main/agent/runtime/learningPipeline';
import { listSkillDrafts, confirmSkillDraft } from '../../../../src/main/services/skills/skillDraftQueue';
import type { AgentEvent } from '../../../../src/shared/contract';

beforeEach(async () => {
  mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-review-'));
  quickMocks.quickTask.mockClear();
});
afterEach(async () => {
  await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
});

function makeCtx(events: AgentEvent[]) {
  return {
    sessionId: 'sess-int',
    onEvent: (e: AgentEvent) => events.push(e),
    messages: [
      { role: 'user', content: '帮我部署 Tauri 应用' },
      { role: 'assistant', content: '已用安装脚本部署' },
      { role: 'user', content: '记住：以后部署都用 scripts/tauri-install.sh' },
    ],
  } as unknown as ConstructorParameters<typeof LearningPipeline>[0];
}

describe('LLM 复盘链真穿透', () => {
  it('runSessionEndLearning → 真复盘 → quickTask → 真 enqueue → 事件 → 真 confirm 落盘', async () => {
    const events: AgentEvent[] = [];
    await new LearningPipeline(makeCtx(events)).runSessionEndLearning();

    // 1) 真的调了 quick model
    expect(quickMocks.quickTask).toHaveBeenCalledTimes(1);

    // 2) 真 enqueue：草稿落盘 + origin=llm-review
    const drafts = await listSkillDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].origin).toBe('llm-review');
    expect(drafts[0].patternKey).toBe('llm-review:deploy-tauri-macos');

    // 3) 真发了 skill_draft_pending 事件，带 origin
    const evt = events.find((e) => e.type === 'skill_draft_pending');
    expect(evt).toBeDefined();
    expect((evt as { data: { drafts: Array<{ origin: string }> } }).data.drafts[0].origin).toBe('llm-review');

    // 4) 真 confirm：过安全闸 + 落 skills 目录
    const result = await confirmSkillDraft(drafts[0].id);
    expect(result.success).toBe(true);
    const installed = await fs.readFile(
      path.join(mockConfigDir.dir, 'skills', 'deploy-tauri-macos', 'SKILL.md'),
      'utf-8',
    );
    expect(installed).toContain('source: llm-review');
  });

  it('已采纳的同 pattern 不再重复入队（accepted ledger 生效）', async () => {
    const events: AgentEvent[] = [];
    await new LearningPipeline(makeCtx(events)).runSessionEndLearning();
    const first = await listSkillDrafts();
    expect(first).toHaveLength(1);
    await confirmSkillDraft(first[0].id); // 采纳并记账

    // 第二次会话同名复盘 → 应被 accepted ledger 挡掉，不再入队
    const events2: AgentEvent[] = [];
    await new LearningPipeline(makeCtx(events2)).runSessionEndLearning();
    expect(await listSkillDrafts()).toHaveLength(0);
    expect(events2.find((e) => e.type === 'skill_draft_pending')).toBeUndefined();
  });
});
