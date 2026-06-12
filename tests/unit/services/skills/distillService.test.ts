import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../../src/shared/contract';
import { DISTILL } from '../../../../src/shared/constants';
import {
  extractDistillSignalsFromRecentMessages,
  formatDistillRunReport,
  runDistill,
  type DistillAssetInventory,
  type DistillEmitters,
  type DistillProposal,
  type DistillSignal,
} from '../../../../src/main/services/skills/distillService';

const NOW = Date.UTC(2026, 5, 12, 9, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function message(overrides: Partial<Message>): Message {
  return {
    id: 'msg-default',
    role: 'user',
    content: '',
    timestamp: NOW,
    ...overrides,
  } as Message;
}

interface FakeSession {
  id: string;
  title: string;
  workingDirectory: string;
  createdAt: number;
  updatedAt: number;
}

function session(id: string, overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    id,
    title: `Session ${id}`,
    workingDirectory: '/repo',
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY / 2,
    ...overrides,
  };
}

/**
 * 朴素 FTS fake：query 的全部空格分词都出现在消息文本里才算命中（对齐 FTS5 AND 语义）。
 */
function makeDb(sessions: FakeSession[], messagesBySession: Record<string, Message[]>) {
  const allMessages: Array<{ msg: Message; sessionId: string }> = [];
  for (const s of sessions) {
    for (const msg of messagesBySession[s.id] ?? []) {
      allMessages.push({ msg, sessionId: s.id });
    }
  }
  return {
    listSessions: vi.fn(() => sessions),
    getRecentMessages: vi.fn((sessionId: string) => messagesBySession[sessionId] ?? []),
    searchTranscriptFts: vi.fn((query: string) => {
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      return allMessages
        .filter(({ msg }) => {
          const text = String(msg.content ?? '').toLowerCase();
          return tokens.every((token) => text.includes(token));
        })
        .map(({ msg, sessionId }) => ({
          messageId: msg.id,
          sessionId,
          kind: 'message' as const,
          toolName: null,
          snippet: String(msg.content ?? '').slice(0, 300),
          timestamp: Number(msg.timestamp ?? NOW),
        }));
    }),
    getTranscriptAround: vi.fn((messageId: string) => {
      const found = allMessages.find(({ msg }) => msg.id === messageId);
      if (!found) return null;
      return {
        sessionId: found.sessionId,
        messages: [{ message: found.msg, matched: true }],
      };
    }),
  };
}

function emptyInventory(): DistillAssetInventory {
  return { commands: [], skills: [], agents: [], rejectedNames: [] };
}

function makeEmitters() {
  const calls: Array<{ kind: 'command' | 'skill'; name: string; draft: boolean; description: string }> = [];
  const emitters: DistillEmitters = {
    emitCommand: vi.fn(async (proposal, opts) => {
      calls.push({ kind: 'command', name: proposal.name, draft: opts.draft, description: proposal.description });
      return { location: `/cmd/${proposal.name}.md`, activated: !opts.draft };
    }),
    emitSkill: vi.fn(async (proposal, opts) => {
      calls.push({ kind: 'skill', name: proposal.name, draft: opts.draft, description: proposal.description });
      return { location: `/skills/${proposal.name}/SKILL.md`, activated: !opts.draft };
    }),
  };
  return { emitters, calls };
}

function signalOf(overrides: Partial<DistillSignal> = {}): DistillSignal {
  return {
    id: 'sig-1',
    title: 'weekly deploy checklist report workflow',
    content: 'run weekly deploy checklist then generate report markdown summary',
    queries: ['weekly deploy checklist'],
    sessionId: 'sess-1',
    sourceKind: 'message',
    ...overrides,
  };
}

/** 两个 session 各有一条支持消息 → frequency 2 / breadth 2 的标准通过场景。 */
function crossSessionSetup() {
  const sessions = [session('sess-1'), session('sess-2', { updatedAt: NOW - DAY / 4 })];
  const supportText = 'run weekly deploy checklist then generate report markdown summary';
  const db = makeDb(sessions, {
    'sess-1': [message({ id: 'msg-a', content: supportText, timestamp: NOW - DAY / 2 })],
    'sess-2': [message({ id: 'msg-b', content: supportText, timestamp: NOW - DAY / 4 })],
  });
  return { sessions, db };
}

describe('distillService', () => {
  describe('runDistill — 六阶段编排', () => {
    it('窗口内无会话 → nothing-to-distill，零产出且不调用 extractor', async () => {
      const db = makeDb([session('old', { createdAt: NOW - 400 * DAY, updatedAt: NOW - 400 * DAY })], { old: [] });
      const extractor = vi.fn(async () => [signalOf()]);
      const { emitters, calls } = makeEmitters();

      const report = await runDistill({
        db,
        now: NOW,
        inventory: async () => emptyInventory(),
        signalExtractor: extractor,
        proposalGenerator: async () => [],
        emitters,
      });

      expect(report.phase).toBe('nothing-to-distill');
      expect(report.signalsDiscovered).toBe(0);
      expect(report.emitted).toHaveLength(0);
      expect(extractor).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    });

    it('频率硬门：信号只在轨迹中出现 1 次 → 拒绝（frequency-below-threshold），不进提案', async () => {
      const sessions = [session('sess-1')];
      const db = makeDb(sessions, {
        'sess-1': [
          message({ id: 'msg-only', content: 'run weekly deploy checklist then generate report markdown summary' }),
        ],
      });
      const generator = vi.fn(async () => []);
      const { emitters } = makeEmitters();

      const report = await runDistill({
        db,
        now: NOW,
        inventory: async () => emptyInventory(),
        signalExtractor: async () => [signalOf()],
        proposalGenerator: generator,
        emitters,
      });

      expect(report.verified).toHaveLength(0);
      expect(report.skippedSignals).toContainEqual(
        expect.objectContaining({ signalId: 'sig-1', reason: 'frequency-below-threshold' }),
      );
      expect(generator).not.toHaveBeenCalled();
      expect(report.emitted).toHaveLength(0);
    });

    it('频率硬门：跨 session 出现 2 次 → 通过，frequency=2 / sessionBreadth=2，提案落盘', async () => {
      const { db } = crossSessionSetup();
      const { emitters, calls } = makeEmitters();
      const generator = vi.fn(async (candidates): Promise<DistillProposal[]> => [
        {
          candidateId: candidates[0].candidateId,
          form: 'command',
          name: 'deploy-report',
          description: '生成每周 deploy checklist 报告',
          body: '跑一遍 deploy checklist，输出 markdown 报告。目标范围: $ARGUMENTS',
        },
      ]);

      const report = await runDistill({
        db,
        now: NOW,
        inventory: async () => emptyInventory(),
        signalExtractor: async () => [signalOf()],
        proposalGenerator: generator,
        emitters,
      });

      expect(report.verified).toHaveLength(1);
      expect(report.verified[0].frequency).toBe(2);
      expect(report.verified[0].sessionBreadth).toBe(2);
      expect(report.verified[0].score).toBeGreaterThan(0);
      expect(report.verified[0].score).toBeLessThanOrEqual(1);
      expect(generator).toHaveBeenCalledOnce();
      expect(report.emitted).toEqual([
        expect.objectContaining({ form: 'command', name: 'deploy-report', activated: true }),
      ]);
      expect(calls).toEqual([expect.objectContaining({ kind: 'command', name: 'deploy-report', draft: false })]);
    });

    it('防幻觉门：FTS 命中但只共享少量泛词 → 相关性不足，拒绝（no-fts-evidence）', async () => {
      // 信号 8+ tokens，命中消息只含其中 2 个泛词 → supportsCandidate 阈值不满足
      const sessions = [session('sess-1'), session('sess-2')];
      const db = makeDb(sessions, {
        'sess-1': [message({ id: 'msg-x', content: 'weekly standup notes about vacation plans' })],
        'sess-2': [message({ id: 'msg-y', content: 'weekly grocery list reminder' })],
      });
      const { emitters } = makeEmitters();

      const report = await runDistill({
        db,
        now: NOW,
        inventory: async () => emptyInventory(),
        signalExtractor: async () => [
          signalOf({
            id: 'sig-generic',
            title: 'orchestrate kubernetes canary rollout pipeline approval',
            content: 'orchestrate kubernetes canary rollout pipeline approval gates metrics dashboards verification',
            queries: ['weekly'],
          }),
        ],
        proposalGenerator: async () => [],
        emitters,
      });

      expect(report.verified).toHaveLength(0);
      expect(report.skippedSignals).toContainEqual(
        expect.objectContaining({ signalId: 'sig-generic', reason: 'no-fts-evidence' }),
      );
    });

    it('盘点去重：信号已被现有资产覆盖（title 全部 tokens 命中同一资产）→ skip covered-by-existing', async () => {
      const { db } = crossSessionSetup();
      const { emitters } = makeEmitters();
      const inventory: DistillAssetInventory = {
        commands: [],
        skills: [
          { name: 'deploy-helper', description: 'weekly deploy checklist report workflow automation for the team' },
        ],
        agents: [],
        rejectedNames: [],
      };

      const report = await runDistill({
        db,
        now: NOW,
        inventory: async () => inventory,
        signalExtractor: async () => [signalOf()],
        proposalGenerator: async () => [],
        emitters,
      });

      expect(report.skippedSignals).toContainEqual(
        expect.objectContaining({ signalId: 'sig-1', reason: 'covered-by-existing' }),
      );
      expect(report.verified).toHaveLength(0);
    });

    it('auto 模式 → emitter 收到 draft: true，产出不激活', async () => {
      const { db } = crossSessionSetup();
      const { emitters, calls } = makeEmitters();

      const report = await runDistill({
        db,
        now: NOW,
        mode: 'auto',
        inventory: async () => emptyInventory(),
        signalExtractor: async () => [signalOf()],
        proposalGenerator: async (candidates) => [
          {
            candidateId: candidates[0].candidateId,
            form: 'skill',
            name: 'deploy-report',
            description: 'desc',
            body: 'skill body content here',
          },
        ],
        emitters,
      });

      expect(calls).toEqual([expect.objectContaining({ kind: 'skill', draft: true })]);
      expect(report.emitted[0].activated).toBe(false);
    });
  });

  describe('runDistill — 提案校验（LLM 产出落盘前）', () => {
    async function runWithProposals(proposals: (candidateId: string) => DistillProposal[], inventory?: DistillAssetInventory) {
      const { db } = crossSessionSetup();
      const { emitters, calls } = makeEmitters();
      const report = await runDistill({
        db,
        now: NOW,
        inventory: async () => inventory ?? emptyInventory(),
        signalExtractor: async () => [signalOf()],
        proposalGenerator: async (candidates) => proposals(candidates[0].candidateId),
        emitters,
      });
      return { report, calls };
    }

    it('非法 name（大写/空格/下划线）→ invalid-name 拒绝', async () => {
      const { report, calls } = await runWithProposals((cid) => [
        { candidateId: cid, form: 'command', name: 'Bad Name_!', description: 'd', body: 'b' },
      ]);
      expect(report.skippedProposals).toContainEqual(expect.objectContaining({ reason: 'invalid-name' }));
      expect(calls).toHaveLength(0);
    });

    it('超长 name（>64）→ invalid-name 拒绝', async () => {
      const { report, calls } = await runWithProposals((cid) => [
        { candidateId: cid, form: 'command', name: `a${'b'.repeat(70)}`, description: 'd', body: 'b' },
      ]);
      expect(report.skippedProposals).toContainEqual(expect.objectContaining({ reason: 'invalid-name' }));
      expect(calls).toHaveLength(0);
    });

    it('空 body → empty-body 拒绝；超长 body → body-too-long 拒绝', async () => {
      const { report, calls } = await runWithProposals((cid) => [
        { candidateId: cid, form: 'command', name: 'empty-one', description: 'd', body: '   ' },
        { candidateId: cid, form: 'command', name: 'huge-one', description: 'd', body: 'x'.repeat(DISTILL.BODY_MAX_LENGTH + 1) },
      ]);
      expect(report.skippedProposals).toContainEqual(expect.objectContaining({ name: 'empty-one', reason: 'empty-body' }));
      expect(report.skippedProposals).toContainEqual(expect.objectContaining({ name: 'huge-one', reason: 'body-too-long' }));
      expect(calls).toHaveLength(0);
    });

    it('超长 description → 截断到上限而非拒绝', async () => {
      const { report, calls } = await runWithProposals((cid) => [
        { candidateId: cid, form: 'command', name: 'long-desc', description: 'd'.repeat(500), body: 'body' },
      ]);
      expect(report.emitted).toHaveLength(1);
      expect(calls[0].description.length).toBeLessThanOrEqual(DISTILL.DESCRIPTION_MAX_LENGTH);
    });

    it('提案引用未入围的 candidateId → unknown-candidate 拒绝（LLM 不得引入候选清单外的工作流）', async () => {
      const { report, calls } = await runWithProposals(() => [
        { candidateId: 'cand-forged', form: 'command', name: 'forged', description: 'd', body: 'b' },
      ]);
      expect(report.skippedProposals).toContainEqual(
        expect.objectContaining({ name: 'forged', reason: 'unknown-candidate' }),
      );
      expect(calls).toHaveLength(0);
    });

    it('与现有 command/skill/agent/被拒名单重名 → name-collision 拒绝，不静默覆盖', async () => {
      const inventory: DistillAssetInventory = {
        commands: [{ name: 'taken-command' }],
        skills: [{ name: 'taken-skill' }],
        agents: ['taken-agent'],
        rejectedNames: ['taken-rejected'],
      };
      const { report, calls } = await runWithProposals(
        (cid) => [
          { candidateId: cid, form: 'command', name: 'taken-command', description: 'd', body: 'b' },
          { candidateId: cid, form: 'skill', name: 'taken-skill', description: 'd', body: 'b' },
          { candidateId: cid, form: 'command', name: 'taken-agent', description: 'd', body: 'b' },
          { candidateId: cid, form: 'command', name: 'taken-rejected', description: 'd', body: 'b' },
        ],
        inventory,
      );
      expect(report.skippedProposals.filter((p) => p.reason === 'name-collision')).toHaveLength(4);
      expect(calls).toHaveLength(0);
    });

    it('subagent 形态只进建议清单，不触发任何 emitter', async () => {
      const { report, calls } = await runWithProposals((cid) => [
        { candidateId: cid, form: 'subagent-recommendation', name: 'release-captain', description: '负责发版编排的 bounded specialist', body: '建议角色职责……' },
      ]);
      expect(report.recommendations).toHaveLength(1);
      expect(report.recommendations[0]).toContain('release-captain');
      expect(calls).toHaveLength(0);
      expect(report.emitted).toHaveLength(0);
    });

    it('emitter 抛错 → emit-failed 记录，不打断整体 run', async () => {
      const { db } = crossSessionSetup();
      const emitters: DistillEmitters = {
        emitCommand: vi.fn(async () => {
          throw new Error('disk full');
        }),
        emitSkill: vi.fn(async () => ({ location: '/skills/x', activated: true })),
      };
      const report = await runDistill({
        db,
        now: NOW,
        inventory: async () => emptyInventory(),
        signalExtractor: async () => [signalOf()],
        proposalGenerator: async (candidates) => [
          { candidateId: candidates[0].candidateId, form: 'command', name: 'boom', description: 'd', body: 'b' },
        ],
        emitters,
      });
      expect(report.phase).toBe('completed');
      expect(report.skippedProposals).toContainEqual(
        expect.objectContaining({ name: 'boom', reason: 'emit-failed', detail: expect.stringContaining('disk full') }),
      );
    });
  });

  describe('extractDistillSignalsFromRecentMessages — 默认信号提取器', () => {
    it('带重复信号词的用户消息产出信号；普通消息不产出；超长内容被截断', async () => {
      const longTail = 'x'.repeat(5000);
      const signals = await extractDistillSignalsFromRecentMessages({
        sessions: [session('sess-1')],
        messagesBySession: new Map([
          [
            'sess-1',
            [
              message({ id: 'm1', role: 'user', content: '每次发版前帮我跑一遍 deploy checklist 然后生成周报' }),
              message({ id: 'm2', role: 'user', content: '今天天气不错' }),
              message({ id: 'm3', role: 'user', content: `老规矩，像上次一样整理 changelog ${longTail}` }),
            ],
          ],
        ]),
        now: NOW,
      });

      expect(signals.length).toBe(2);
      expect(signals.every((s) => s.content.length <= 600)).toBe(true);
      expect(signals[0].queries.length).toBeGreaterThan(0);
    });
  });

  describe('formatDistillRunReport', () => {
    it('报告含六阶段结构与产出明细', async () => {
      const { db } = crossSessionSetup();
      const { emitters } = makeEmitters();
      const report = await runDistill({
        db,
        now: NOW,
        inventory: async () => emptyInventory(),
        signalExtractor: async () => [signalOf()],
        proposalGenerator: async (candidates) => [
          { candidateId: candidates[0].candidateId, form: 'command', name: 'deploy-report', description: 'd', body: 'b' },
        ],
        emitters,
      });
      const text = formatDistillRunReport(report);
      expect(text).toContain('盘点');
      expect(text).toContain('频率验证');
      expect(text).toContain('打分');
      expect(text).toContain('产出');
      expect(text).toContain('deploy-report');
    });
  });
});
