// ============================================================================
// Distill 真实数据实跑（roadmap 3.2 验收证据 runner）
// ============================================================================
// 默认跳过；显式运行：
//   DISTILL_REAL_DB=1 npx vitest run tests/integration/distillRealRun.test.ts
//
// 安全设计：
// - 真实 DB 先复制到临时目录，全部读写发生在副本上（原库零接触）
// - 副本上用生产迁移补建 transcript_fts（applyTranscriptFtsSchema +
//   backfillTranscriptFts），频率验证踩的是生产 SQL
// - 产出定向到临时 workspace（emitters 注入），不污染用户配置目录
// ============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionRepository } from '../../src/main/services/core/repositories/SessionRepository';
import { applySessionsMigrations } from '../../src/main/services/core/database/migrations';
import { applyTranscriptFtsSchema } from '../../src/shared/transcriptFts.sql';
import { createLogger } from '../../src/main/services/infra/logger';
import { executeDistillRun } from '../../src/main/services/skills/distillExecutor';
import { llmDistillProposalGenerator } from '../../src/main/services/skills/distillProposalGenerator';
import { emitCommandFile } from '../../src/main/services/commands/commandFileEmitter';
import { PromptCommandService } from '../../src/main/services/commands/promptCommandService';
import type {
  DistillDatabase,
  DistillEmitters,
  DistillProposal,
  DistillSignal,
  DistillVerifiedCandidate,
} from '../../src/main/services/skills/distillService';

const ENABLED = process.env.DISTILL_REAL_DB === '1';
const REAL_DB_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'code-agent', 'code-agent.db');
const RUN_TIMEOUT = 180_000;
/** 验收证据落盘（vitest 默认 reporter 会吞通过用例的 console 输出） */
const EVIDENCE_FILE = '/tmp/distill-run-evidence.md';

async function evidence(section: string, content: string): Promise<void> {
  console.log(`\n===== ${section} =====\n${content}\n=====\n`);
  await fs.appendFile(EVIDENCE_FILE, `\n## ${section}\n\n${content}\n`, 'utf-8');
}

let tmpRoot = '';
let db: InstanceType<typeof Database>;
let repo: SessionRepository;
let adapter: DistillDatabase;
let dataNow = 0;
let workspace = '';
let commandsDir = '';
let draftsDir = '';

function cjkQueries(text: string): string[] {
  const runs = text.match(/[一-鿿]{3,6}/g) ?? [];
  const ascii = text.toLowerCase().match(/[a-z0-9-]{4,}/g) ?? [];
  return Array.from(new Set([...runs, ...ascii])).slice(0, 3);
}

function buildSignal(id: string, content: string): DistillSignal {
  const flat = content.replace(/\s+/g, ' ').trim().slice(0, 600);
  return {
    id,
    title: flat.slice(0, 80),
    content: flat,
    queries: cjkQueries(flat),
    sessionId: null,
    sourceKind: 'message',
  };
}

function tmpEmitters(): DistillEmitters {
  return {
    emitCommand: (proposal, opts) =>
      emitCommandFile(
        { name: proposal.name, description: proposal.description, body: proposal.body },
        { draft: opts.draft, commandsDir, draftsDir },
      ),
    emitSkill: async (proposal) => {
      // 真实 skill 注册依赖运行中的 skillDiscoveryService；实跑证据以 command 通道为准
      const skillPath = path.join(workspace, '.code-agent', 'skills', proposal.name, 'SKILL.md');
      await fs.mkdir(path.dirname(skillPath), { recursive: true });
      await fs.writeFile(skillPath, `---\nname: ${proposal.name}\ndescription: "${proposal.description}"\n---\n\n${proposal.body}\n`, { flag: 'wx' });
      return { location: skillPath, activated: true };
    },
  };
}

describe.skipIf(!ENABLED)('distill 真实数据实跑（六阶段验收）', () => {
  beforeAll(async () => {
    await fs.access(REAL_DB_PATH);
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'distill-real-'));
    const dbCopy = path.join(tmpRoot, 'code-agent-copy.db');
    await fs.copyFile(REAL_DB_PATH, dbCopy);

    db = new Database(dbCopy);
    // 旧库（2.1 History 落地前）缺新列与 transcript_fts：在副本上跑生产迁移 + 回填
    applySessionsMigrations(db, createLogger('DistillRealRun'));
    applyTranscriptFtsSchema(db);
    repo = new SessionRepository(db);
    const backfilled = repo.backfillTranscriptFts();
    const ftsRows = (db.prepare('SELECT count(*) AS n FROM transcript_fts').get() as { n: number }).n;
    const row = db.prepare('SELECT max(updated_at) AS m FROM sessions').get() as { m: number };
    dataNow = Number(row.m) + 60 * 60 * 1000;

    await fs.writeFile(EVIDENCE_FILE, `# Distill 真实数据实跑证据（数据窗口锚点 ${new Date(dataNow).toISOString()}）\n`, 'utf-8');
    await evidence('[setup] 环境', `DB 副本: ${dbCopy}\ntranscript_fts 回填: backfilled=${backfilled}, rows=${ftsRows}`);

    adapter = {
      listSessions: (limit, offset, includeArchived) => repo.listSessions(limit ?? 50, offset ?? 0, includeArchived ?? false),
      getRecentMessages: (sessionId, count) => repo.getRecentMessages(sessionId, count),
      searchTranscriptFts: (query, options) => repo.searchTranscriptFts(query, options),
      getTranscriptAround: (messageId, options) => repo.getTranscriptAround(messageId, options),
    };

    workspace = path.join(tmpRoot, 'workspace');
    commandsDir = path.join(workspace, '.code-agent', 'commands');
    draftsDir = path.join(workspace, '.code-agent', 'command-drafts');
    await fs.mkdir(workspace, { recursive: true });

    // 让 quickTask 的 env 兜底可用（key 不打印）
    if (!process.env.ZHIPU_API_KEY) {
      try {
        const envRaw = await fs.readFile(path.join(os.homedir(), '.code-agent', '.env'), 'utf-8');
        for (const line of envRaw.split('\n')) {
          const kv = /^(ZHIPU(?:_OFFICIAL)?_API_KEY)=(.+)$/.exec(line.trim());
          if (kv) process.env[kv[1]] = kv[2];
        }
      } catch {
        /* 无 env 文件则走脚本化提案兜底 */
      }
    }
  }, RUN_TIMEOUT);

  afterAll(() => {
    db?.close();
  });

  it('A. 生产默认配置完整六阶段实跑（默认信号提取器）', async () => {
    const report = await executeDistillRun(
      { skillName: 'distill', args: undefined, workingDirectory: '', matchKind: 'slash' },
      { db: adapter, now: dataNow, emitters: tmpEmitters() },
    );
    await evidence('[A] 默认配置实跑报告', report);
    expect(report).toContain('阶段 1 盘点');
    expect(report).toContain('阶段 2 扫描重复信号');
    expect(report).toContain('频率验证');
  }, RUN_TIMEOUT);

  it('B. 频率硬门在真实轨迹上：重复工作流通过，单次/无证据信号被拒；产出 command 注册后真实可调用', async () => {
    // 从真实数据动态找重复 / 单次的用户消息
    const repeated = db
      .prepare(
        `SELECT content, COUNT(*) AS n FROM messages
         WHERE role='user' AND length(content) BETWEEN 20 AND 500
         GROUP BY content HAVING n >= 2 ORDER BY n DESC LIMIT 1`,
      )
      .get() as { content: string; n: number } | undefined;
    expect(repeated, '真实数据中应存在重复的用户工作流消息').toBeTruthy();
    await evidence('[B] 真实数据信号', `重复信号（出现 ${repeated!.n} 次）: ${repeated!.content.slice(0, 80).replace(/\s+/g, ' ')}...`);

    // 注：频率门的口径是"FTS 轨迹中的 distinct 出现次数"，不是"作为完整消息出现的次数"。
    // 单次信号（频率=1）的精确拒绝路径由单测确定性覆盖（distillService.test.ts），
    // 真实数据上演示的是 0 证据拒绝（虚构信号）+ 重复信号通过。
    const signals: DistillSignal[] = [buildSignal('sig-repeated', repeated!.content)];
    signals.push({
      id: 'sig-no-evidence',
      title: 'zxqv 不存在的虚构工作流 quux 校验',
      content: 'zxqv 不存在的虚构工作流 quux 校验 这段文本不应出现在任何轨迹里',
      queries: ['zxqvquux'],
      sessionId: null,
      sourceKind: 'message',
    });

    // 提案：先尝试真实 LLM 通道；不可用则脚本化兜底（输出中明示）
    const generator = async (
      candidates: DistillVerifiedCandidate[],
      context: Parameters<typeof llmDistillProposalGenerator>[1],
    ): Promise<DistillProposal[]> => {
      const llm = await llmDistillProposalGenerator(candidates, context);
      const commands = llm.filter((p) => p.form === 'command');
      if (commands.length > 0) {
        await evidence('[B] 提案通道', `真实 LLM 提案通道生效: ${llm.length} 条提案（含 ${commands.length} 条 command）`);
        return llm;
      }
      await evidence('[B] 提案通道', 'LLM 提案不可用或无 command 形态，使用脚本化提案兜底（六阶段与硬门不受影响）');
      return [
        {
          candidateId: candidates[0].candidateId,
          form: 'command',
          name: 'cafe-sales-analysis',
          description: '分析咖啡店销售数据：总营收、最畅销单品、每日营收趋势',
          body: '分析以下销售数据，输出总营收、最畅销单品、每日营收趋势：\n\n$ARGUMENTS',
        },
      ];
    };

    const report = await executeDistillRun(
      { skillName: 'distill', args: undefined, workingDirectory: '', matchKind: 'slash' },
      { db: adapter, now: dataNow, emitters: tmpEmitters(), signalExtractor: () => signals, proposalGenerator: generator },
    );
    await evidence('[B] 六阶段实跑报告（真实轨迹 + 频率硬门）', report);

    // 硬门断言：重复信号通过入围、虚构信号被拒
    expect(report).toMatch(/sig-no-evidence: no-fts-evidence/);
    expect(report).toContain('[cand_');

    // 产出与注册：emitted 的 command 通过 promptCommandService 真实调用一次
    const emittedMatch = /✓ \[command\] ([a-z0-9-]+) → (\S+)/.exec(report);
    expect(emittedMatch, '报告中应有已注册激活的 command 产出').toBeTruthy();
    const commandName = emittedMatch![1];
    const resolution = await new PromptCommandService().resolveInvocation(`/${commandName} 2026-06 周报数据`, workspace);
    expect(resolution).not.toBeNull();
    expect(resolution!.source).toBe('file');
    expect(resolution!.prompt.length).toBeGreaterThan(10);
    await evidence(`[B] 真实调用 /${commandName}`, `resolveInvocation('/${commandName} 2026-06 周报数据') → source=${resolution!.source}\n展开 prompt:\n${resolution!.prompt}`);
  }, RUN_TIMEOUT);
});
