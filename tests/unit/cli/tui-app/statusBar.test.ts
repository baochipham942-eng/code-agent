import { describe, expect, it } from 'vitest';
import { formatStatusBar } from '../../../../src/cli/tui-app/statusBar';

describe('formatStatusBar', () => {
  it('左权限+模型+供应商+分支，右 token/ctx/成本', () => {
    const { left, right } = formatStatusBar({
      permissionLabel: 'ask',
      model: 'glm-5.3-flash',
      provider: 'custom-tokenrhythm',
      gitBranch: 'main',
      gitDirty: true,
      inputTokens: 35532,
      outputTokens: 490,
      contextPercent: 0,
      costUsd: 0.037,
    });
    expect(left).toBe('ask  glm-5.3-flash  (custom-tokenrhythm)  main*');
    expect(right).toBe('⇡35532 ⇣490  ctx ░░░░░ 0%  $0.0370');
    expect(left).not.toContain('/Users');
    expect(right).not.toContain('idle');
    expect(right).not.toContain('running');
  });

  it('空闲无用量时右侧为空', () => {
    const { right } = formatStatusBar({
      permissionLabel: 'ask',
      model: 'glm-5.3-flash',
      provider: '',
      gitBranch: 'main',
      inputTokens: 0,
      outputTokens: 0,
      contextPercent: null,
      costUsd: 0,
    });
    expect(right).toBe('');
  });
});
