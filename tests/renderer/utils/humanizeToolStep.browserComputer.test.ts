import { describe, expect, it } from 'vitest';
import { humanizeToolStep } from '../../../src/renderer/utils/humanizeToolStep';
import { zh } from '../../../src/renderer/i18n/zh';

describe('humanizeToolStep browser/computer labels', () => {
  it('formats browser_action labels with action and target', () => {
    expect(humanizeToolStep('browser_action', {
      action: 'click',
      selector: '#phase3-workflow-button',
    }, zh)).toBe('浏览器 click #phase3-workflow-button');
  });

  it('formats computer_use labels with action and target app', () => {
    expect(humanizeToolStep('computer_use', {
      action: 'type',
      targetApp: 'Google Chrome',
      text: 'secret@example.com',
    }, zh)).toBe('电脑操作 type Google Chrome');
  });

  it('falls back to action only when no target is present', () => {
    expect(humanizeToolStep('computer_use', {
      action: 'observe',
    }, zh)).toBe('电脑操作 observe');
  });
});
