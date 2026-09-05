// admin 控制台「上线后质量」的聚合口径（ADR-063 §2/§4 · N-EVAL-POSTLAUNCH-K3）。
// 纯函数，不碰 supabase、不碰网络、不碰数据目录。
import { describe, expect, it } from 'vitest';
import {
  isNewerRubric,
  overallPassRate,
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
