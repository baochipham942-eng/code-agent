// admin 控制台「上线后质量」的聚合口径（ADR-063 §2/§4 · N-EVAL-POSTLAUNCH-K3）。
// 纯函数，不碰 supabase、不碰网络、不碰数据目录。
import { describe, expect, it } from 'vitest';
import {
  fetchQualityRows,
  isNewerRubric,
  overallPassRate,
  readRows,
  rollupByUser,
  rollupByWeek,
  type QualityRow,
} from '../../../admin-console/lib/postlaunch';

const BASE: QualityRow = {
  week_start: '2026-08-31T00:00:00+00:00',
  day_start: '2026-09-05T00:00:00+00:00',
  app_version: '0.33.0',
  prompt_version: 'p7',
  judge_version: 'postlaunch-judge-v1',
  rubric_version: 'postlaunch-rubric-v1',
  user_id: 'u1',
  sampled_by: 'sample',
  turns: 1,
  sessions: 1,
  last_scored_at: 1_780_000_000_000,
  goal_judged: 1, goal_passed: 1,
  orchestration_judged: 0, orchestration_passed: 0,
  tools_judged: 0, tools_passed: 0,
  permission_judged: 0, permission_passed: 0,
  safety_judged: 0, safety_passed: 0,
  artifact_judged: 0, artifact_passed: 0,
  judge_unavailable_turns: 0,
  cost_usd: 0,
  failure_classes: null,
};

function row(patch: Partial<QualityRow>): QualityRow {
  return { ...BASE, ...patch };
}

describe('rollupByUser 的口径纪律', () => {
  it('信号轮与抽样轮不合并：两行各自出过率，不给合并值（ADR-063 §4）', () => {
    // 信号轮 0/2 通过，抽样轮 2/2 通过。合并会算出 50%，那个数字什么都不代表。
    const quality = rollupByUser([
      row({ sampled_by: 'signal', turns: 2, goal_judged: 2, goal_passed: 0 }),
      row({ sampled_by: 'sample', turns: 2, goal_judged: 2, goal_passed: 2 }),
    ]).get('u1');

    expect(overallPassRate(quality!.signal!)).toBe(0);
    expect(overallPassRate(quality!.sample!)).toBe(1);
    expect(quality!.signal!.turns).toBe(2);
    expect(quality!.sample!.turns).toBe(2);
  });

  it('只升 rubric 也算换了口径：judge 相同不代表两批分数可比（ADR-063 §2）', () => {
    const quality = rollupByUser([
      row({ rubric_version: 'postlaunch-rubric-v1', last_scored_at: 1_000, goal_judged: 1, goal_passed: 0 }),
      row({ rubric_version: 'postlaunch-rubric-v2', last_scored_at: 2_000, goal_judged: 1, goal_passed: 1 }),
    ]).get('u1');

    // 只卷新口径那一行，旧 rubric 的不加进来
    expect(quality!.rubric).toEqual({
      judgeVersion: 'postlaunch-judge-v1',
      rubricVersion: 'postlaunch-rubric-v2',
    });
    expect(quality!.sample!.turns).toBe(1);
    expect(overallPassRate(quality!.sample!)).toBe(1);
  });

  it('同一天两版口径：结果与行的返回顺序无关（排序键是 last_scored_at，不是 day_start）', () => {
    const older = row({ rubric_version: 'postlaunch-rubric-v1', last_scored_at: 1_000, goal_passed: 0 });
    const newer = row({ rubric_version: 'postlaunch-rubric-v2', last_scored_at: 2_000, goal_passed: 1 });
    // 两行 day_start 相同（都是 BASE 那天）——只比天就会靠数组顺序定胜负。

    const forward = rollupByUser([older, newer]).get('u1');
    const reversed = rollupByUser([newer, older]).get('u1');

    expect(forward!.rubric).toEqual(reversed!.rubric);
    expect(forward!.rubric.rubricVersion).toBe('postlaunch-rubric-v2');
    expect(overallPassRate(forward!.sample!)).toBe(overallPassRate(reversed!.sample!));
  });

  it('last_scored_at 完全并列时按版本串比较，仍是确定的全序', () => {
    const a = { lastScoredAt: 5, judgeVersion: 'j1', rubricVersion: 'r1' };
    const b = { lastScoredAt: 5, judgeVersion: 'j1', rubricVersion: 'r2' };
    expect(isNewerRubric(b, a)).toBe(true);
    expect(isNewerRubric(a, b)).toBe(false);
  });
});

describe('rollupByWeek 的口径纪律', () => {
  it('rubric 版本进分组键：只升 rubric 的两批不会被并成一个过率', () => {
    const buckets = rollupByWeek([
      row({ rubric_version: 'postlaunch-rubric-v1' }),
      row({ rubric_version: 'postlaunch-rubric-v2' }),
    ]);
    expect(buckets).toHaveLength(2);
    expect(buckets.map((b) => b.rubricVersion).sort()).toEqual([
      'postlaunch-rubric-v1',
      'postlaunch-rubric-v2',
    ]);
  });

  it('信号轮与抽样轮各自成桶', () => {
    const buckets = rollupByWeek([row({ sampled_by: 'signal' }), row({ sampled_by: 'sample' })]);
    expect(buckets.map((b) => b.sampledBy).sort()).toEqual(['sample', 'signal']);
  });
});

describe('readRows：截断判据与错误分支', () => {
  it('截断看服务端 count，不看返回条数是否达到客户端 limit', () => {
    // 真实形状：客户端要了 2000 行，PostgREST 自己的 db-max-rows（Supabase 默认 1000）
    // 只给 1000 行。靠「返回数 > 我要的数」探测的写法在这里会安静地判成没截断。
    const out = readRows({ data: new Array(1000).fill({}), error: null, count: 1500 });
    expect(out.truncated).toBe(true);
    expect(out.rows).toHaveLength(1000);
    expect(out.error).toBeNull();
  });

  it('count 等于返回条数就是读全了', () => {
    expect(readRows({ data: [{}, {}], error: null, count: 2 }).truncated).toBe(false);
  });

  it('查询出错不返回空数组当结果：error 非空，truncated 不误报', () => {
    const out = readRows({ data: null, error: { message: 'statement timeout' }, count: null });
    expect(out.error).toBe('statement timeout');
    expect(out.rows).toEqual([]);
    expect(out.truncated).toBe(false);
  });

  it('查成功且真的没有数据时 error 才是 null——空态与失败态分得开', () => {
    const out = readRows({ data: [], error: null, count: 0 });
    expect(out.error).toBeNull();
    expect(out.rows).toEqual([]);
  });
});

/** 只实现 fetchQualityRows 用到的那几步链式调用。 */
function fakeSupabase(result: { data: unknown; error: { message: string } | null; count: number | null }) {
  const builder = {
    select: () => builder,
    gte: () => builder,
    order: () => builder,
    limit: () => builder,
    returns: () => Promise.resolve(result),
  };
  return { from: () => builder } as never;
}

describe('fetchQualityRows', () => {
  it('视图读失败时把错误带出来，不伪装成「暂无上线后评分」', async () => {
    const out = await fetchQualityRows(
      fakeSupabase({ data: null, error: { message: 'relation "admin_postlaunch_quality" does not exist' }, count: null }),
      28,
    );
    expect(out.error).toContain('admin_postlaunch_quality');
    expect(out.rows).toEqual([]);
  });

  it('服务端还有更多行时报截断', async () => {
    const out = await fetchQualityRows(fakeSupabase({ data: [BASE], error: null, count: 42 }), 28);
    expect(out.truncated).toBe(true);
    expect(out.error).toBeNull();
  });
});
