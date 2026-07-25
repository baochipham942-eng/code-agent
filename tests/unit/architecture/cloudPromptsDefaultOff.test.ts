// ============================================================================
// 云端 System Prompt 下发的「默认关闭」语义门
//
// 这条通道绕过全部质量门：prompt 改动没有 CI、没有 eval、没有棘轮，改错了对全量用户
// 立刻生效，症状是「agent 变笨了」这种最难归因的形态。2026-07-25 的产品判断是
// 「通道建好待命、默认不通电」。
//
// 本门钉住那个「默认」：没有它，把开关改成默认开启（或把判据从 === '1' 放宽成
// 「非 '0' 即开」）不会让任何测试变红，一次手滑就把无人看管的旁路接到所有用户身上。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { isCloudPromptsEnabled } from '../../../src/web/webStartupCloudPrompts';

describe('云端 prompt 下发默认关闭', () => {
  it('环境变量缺省时关闭', () => {
    expect(isCloudPromptsEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('只有显式 =1 才开启', () => {
    expect(isCloudPromptsEnabled({ CODE_AGENT_CLOUD_PROMPTS: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it.each(['0', '', 'true', 'yes', 'on', 'TRUE'])('模糊真值 %j 一律视为关闭（不放宽判据）', (value) => {
    expect(isCloudPromptsEnabled({ CODE_AGENT_CLOUD_PROMPTS: value } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});
