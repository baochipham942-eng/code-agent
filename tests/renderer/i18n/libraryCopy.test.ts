import { describe, expect, it } from 'vitest';
import { libraryZh } from '../../../src/renderer/i18n/library';
import { sidebarZh } from '../../../src/renderer/i18n/sidebar';

// 产品负责人直接问过「可 pin 进对话是什么意思」——pin 是黑话，中文文案不许回潮。
// 只扫**值**：pinModalTitle 这类 key 是代码标识符，不是用户看得到的文案，
// 扫 JSON 全串会把 key 名一起算进去，那样测的就不是文案了。
describe('资料库中文文案', () => {
  it('不向用户暴露 pin 这个英文动作词', () => {
    const values = [
      ...Object.values(libraryZh.library),
      ...Object.values(sidebarZh.sidebar.capabilityZone),
    ].filter((value): value is string => typeof value === 'string');

    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value.toLowerCase(), `「${value}」仍含 pin`).not.toContain('pin');
    }
  });
});
