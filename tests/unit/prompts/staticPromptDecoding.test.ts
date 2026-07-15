// ============================================================================
// 常驻提示词的默认宇宙观（方案 D 一期）
//
// few-shot 是「按特征触发」的，#378/#382 已修完；这里管的是「每轮必带」的那 2690 token
// —— 它的默认宇宙观原本是「用户在写软件」：
//   - identity.ts 把「已经改了代码」列为完成条件 → 用户要一份 PPT，模型按此永远无法完成
//   - 「Search first … to understand the codebase」把探索窄化成读代码库
//   - 「Follow existing code style」只讲代码风格
//   - 并行范例全是 git status + git diff
//   - 记忆黑名单只点名 code/git
//
// Agent Neo 是产物为主轴的 cowork 产品，默认用户是非程序员协作者。改法是**泛化而非替换**
// ——代码是产物的一种，编程场景一个字都不能弄坏。
//
// 纪律：静态层是字符串，组装结果可纯函数断言——能免费确定性验证的不许拿模型跑。
// eval 只用来测行为，不用来测「这句话还在不在」。
// ============================================================================

import { describe, expect, it } from 'vitest';
import '../../../src/host/prompts/promptIndex';
import { IDENTITY_PROMPT } from '../../../src/host/prompts/identity';
import { TOOLS_PROMPT } from '../../../src/host/prompts/base';

const ALWAYS_ON = `${IDENTITY_PROMPT}\n${TOOLS_PROMPT}`;
const estimateTokens = (t: string) => Math.ceil(t.length / 4);

describe('常驻层：编程独占的断言必须清掉', () => {
  it.each([
    // 完成条件写死「改了代码」——PPT / 报告 / 海报类任务按此定义无法完成
    ['made code changes that address', '把「已经改了代码」列为完成条件'],
    // 探索被窄化成「读代码库」
    ['to understand the codebase', '把 Search first 的目的窄化成理解代码库'],
    // 一致性只讲代码风格
    ['code style to maintain consistency', '一致性要求只覆盖代码风格'],
  ])('不得再出现: %s（%s）', (phrase) => {
    expect(ALWAYS_ON).not.toContain(phrase);
  });

  it('完成条件覆盖产物，不只覆盖代码', () => {
    // 只断言 not.toContain 会被「整段被删」骗过——正向也要断言
    expect(ALWAYS_ON).toContain('deliverable');
    expect(ALWAYS_ON.toLowerCase()).toContain('deck');
    expect(ALWAYS_ON.toLowerCase()).toContain('spreadsheet');
    // 产物的验收方式：回读产物本身
    expect(ALWAYS_ON.toLowerCase()).toContain('placeholder');
  });
});

describe('反回归：编程场景一个字都不能弄坏', () => {
  it.each([
    'typecheck',
    'tests',
    'git',
    'Glob',
    'Grep',
    'Bash',
    'Read before Edit',
    'minimal and focused',
  ])('编程能力仍在常驻层保留: %s', (phrase) => {
    expect(ALWAYS_ON).toContain(phrase);
  });

  it('验收纪律本身没被稀释', () => {
    // 泛化的是「什么算产物」，不是「要不要验证」
    expect(ALWAYS_ON).toContain('DO NOT claim completion without a preceding verification tool call');
    expect(ALWAYS_ON).toContain('You are NOT done until ALL of the following are true');
  });
});

describe('常驻层体量', () => {
  it('每轮必带，不许无节制膨胀', () => {
    // 改前实测 2690（identity 2241 + tools 449）。泛化必然带来一点净增，
    // 但这是每轮都付的钱（有前缀缓存兜底），给一个会响的上限而不是随它涨。
    const total = estimateTokens(IDENTITY_PROMPT) + estimateTokens(TOOLS_PROMPT);
    expect(total).toBeLessThanOrEqual(3000);
  });
});
