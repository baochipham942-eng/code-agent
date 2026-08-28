import { describe, expect, it } from 'vitest';
import { humanizeToolStep } from '../../../src/renderer/utils/humanizeToolStep';
import { zh } from '../../../src/renderer/i18n/zh';

describe('humanizeToolStep browser/computer labels', () => {
  it('formats browser_action labels without exposing the raw function action', () => {
    expect(humanizeToolStep('browser_action', {
      action: 'click',
      selector: '#phase3-workflow-button',
    }, zh)).toBe('操作了浏览器 · #phase3-workflow-button');
  });

  it('formats computer_use labels with action and target app', () => {
    expect(humanizeToolStep('computer_use', {
      action: 'type',
      targetApp: 'Google Chrome',
      text: 'secret@example.com',
    }, zh)).toBe('操作了电脑 · Google Chrome');
  });

  it('falls back to action only when no target is present', () => {
    expect(humanizeToolStep('computer_use', {
      action: 'observe',
    }, zh)).toBe('查看了电脑状态');
  });

  it('clear_cookies uses the browser-domain delete template, never the raw action', () => {
    const line = humanizeToolStep('browser_action', { action: 'clear_cookies' }, zh, undefined, 'failed');
    expect(line).toBe('清理浏览器数据未成功');
    expect(line).not.toContain('clear_cookies');
  });

  it('a tool absent from every vocabulary still produces a human main line', () => {
    const name = 'quantum_reconcile_widget';
    const line = humanizeToolStep(name, {}, zh, undefined, 'failed');
    expect(line).toBe('执行工具操作未成功');
    expect(line).not.toContain(name);
  });
});
