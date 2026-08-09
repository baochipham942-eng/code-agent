import { describe, expect, it } from 'vitest';

import { normalizeSessionTaskShortName } from '../../../../src/host/tools/modules/commandCenter/sessionCommandCenter';
import { delegateTaskSchema } from '../../../../src/host/tools/modules/commandCenter/sessionCommandCenter.schema';

describe('session command center short_name normalization', () => {
  it.each([
    ['周报', '周报'],
    ['ReactResearch', 'RR'],
    ['research', 'rese'],
    ['竞品研究任务', '竞品研究'],
    ['R', 'R研究任'],
  ])('normalizes %s to a stable 2-4 character key', (input, expected) => {
    expect(normalizeSessionTaskShortName(input, '研究任务')).toBe(expected);
  });

  it('documents the same 2-4 character contract accepted by normalization', () => {
    const description = delegateTaskSchema.inputSchema.properties?.short_name?.description;
    expect(description).toContain('2-4 个字符');
    expect(description).toContain('中文或英文');
    expect(description).toContain('归一化');
  });
});
