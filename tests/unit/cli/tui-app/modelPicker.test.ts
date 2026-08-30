// ============================================================================
// tui-app/modelPicker.ts — /model 选择器数据构建 单测
// ============================================================================

import { describe, expect, it } from 'vitest';
import { buildModelPickerItems } from '../../../../src/cli/tui-app/modelItems';

const REGISTRY = {
  deepseek: { displayName: 'DeepSeek', defaultModel: 'deepseek-v4-flash' },
  claude: { displayName: 'Anthropic Claude', defaultModel: 'claude-opus-4-7' },
  longcat: { displayName: 'LongCat', defaultModel: 'LongCat-2.0' },
};

const ENV_KEYS = { deepseek: 'DEEPSEEK_API_KEY', claude: 'ANTHROPIC_API_KEY' };

describe('buildModelPickerItems', () => {
  it('按注册表生成条目：key 状态与当前标记', () => {
    const items = buildModelPickerItems(REGISTRY, ENV_KEYS, { DEEPSEEK_API_KEY: 'sk-x' }, 'claude');
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      id: 'deepseek', label: 'DeepSeek', defaultModel: 'deepseek-v4-flash', hasKey: true, current: false,
    });
    expect(items[1]).toMatchObject({ id: 'claude', hasKey: false, current: true });
    // 无 env key 映射的 provider → hasKey false
    expect(items[2]).toMatchObject({ id: 'longcat', hasKey: false, current: false });
  });

  it('当前 provider 无匹配时全部 current=false', () => {
    const items = buildModelPickerItems(REGISTRY, ENV_KEYS, {}, 'nonexistent');
    expect(items.every((item) => !item.current)).toBe(true);
  });
});
