// ============================================================================
// extractPlanTitle — 单测覆盖 plan 标题识别正则
// ============================================================================
// 验证规则：识别显式 "Plan / 计划" 前缀的标题或加粗；裸标题不识别。

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: false }),
}));

import { extractPlanTitle } from '../../../src/host/agent/todoParser';

describe('extractPlanTitle', () => {
  it('returns null for empty / short content', () => {
    expect(extractPlanTitle('')).toBeNull();
    expect(extractPlanTitle('hello')).toBeNull();
  });

  it('returns null for plain heading without "Plan" prefix', () => {
    expect(extractPlanTitle('# 重构 Auth 模块\n- [ ] step 1')).toBeNull();
    expect(extractPlanTitle('## 计划与思路\n- [ ] step 1')).toBeNull();
  });

  it('extracts plan title from H1/H2/H3 with "Plan:" prefix (English)', () => {
    expect(extractPlanTitle('# Plan: 重构 Auth 模块')).toBe('重构 Auth 模块');
    expect(extractPlanTitle('## Plan: Multi-provider OAuth')).toBe('Multi-provider OAuth');
    expect(extractPlanTitle('### plan: lowercase ok')).toBe('lowercase ok');
  });

  it('extracts plan title from heading with 中文 "计划：" prefix', () => {
    expect(extractPlanTitle('## 计划：重构 Auth 模块为多 provider 支持')).toBe(
      '重构 Auth 模块为多 provider 支持',
    );
    expect(extractPlanTitle('# 计划: 半角冒号也认')).toBe('半角冒号也认');
  });

  it('extracts plan title from bold form **Plan**: XXX', () => {
    expect(extractPlanTitle('**Plan**: 重构 Auth')).toBe('重构 Auth');
    expect(extractPlanTitle('**计划**：处理边界条件')).toBe('处理边界条件');
  });

  it('ignores plan title inside fenced code blocks', () => {
    const content = '```md\n## Plan: not real plan\n```\n- [ ] step';
    expect(extractPlanTitle(content)).toBeNull();
  });

  it('returns null for over-long title (>200 chars)', () => {
    const long = 'x'.repeat(220);
    expect(extractPlanTitle(`## Plan: ${long}`)).toBeNull();
  });

  it('returns first matching plan title when multiple present', () => {
    const content = '## Plan: 第一个计划\n- [ ] a\n\n## Plan: 第二个计划';
    expect(extractPlanTitle(content)).toBe('第一个计划');
  });
});
