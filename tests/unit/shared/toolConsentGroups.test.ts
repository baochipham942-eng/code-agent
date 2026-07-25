import { describe, expect, it } from 'vitest';
import { CORE_TOOLS } from '../../../src/host/services/toolSearch/deferredTools';
import { TOOL_CONSENT_MAP, groupToolsForConsent } from '../../../src/shared/constants/toolConsentGroups';

describe('工具 → 用户后果 映射', () => {
  it('核心工具集全部有映射——新增核心工具忘了写人话会在这里红', () => {
    const missing = CORE_TOOLS.filter((tool) => !TOOL_CONSENT_MAP[tool]);
    expect(missing).toEqual([]);
  });

  it('陌生工具进 unmapped 而不是被丢掉', () => {
    const { groups, unmapped } = groupToolsForConsent(['Read', 'no_such_tool', 'no_such_tool']);
    expect(groups).toEqual([{ group: 'file', effects: ['readFile'] }]);
    expect(unmapped).toEqual(['no_such_tool']);
  });

  it('同后果的工具合成一条，分组按后果轻重排（能运行命令的排在能看文件的前面）', () => {
    const { groups } = groupToolsForConsent(['Glob', 'Grep', 'ListDirectory', 'WebSearch', 'Bash']);
    expect(groups).toEqual([
      { group: 'command', effects: ['runCommand'] },
      { group: 'file', effects: ['searchFile'] },
      { group: 'network', effects: ['webSearch'] },
    ]);
  });
});
