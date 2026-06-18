import { describe, expect, it } from 'vitest';
import { buildSingleToolLabel } from '../../../src/renderer/utils/toolStepGrouping';

describe('toolStepGrouping browser/computer labels', () => {
  it('formats browser_action labels with action and target', () => {
    expect(buildSingleToolLabel('browser_action', {
      action: 'click',
      selector: '#phase3-workflow-button',
    })).toBe('浏览器 click #phase3-workflow-button');
  });

  it('formats computer_use labels with action and target app', () => {
    expect(buildSingleToolLabel('computer_use', {
      action: 'type',
      targetApp: 'Google Chrome',
      text: 'secret@example.com',
    })).toBe('电脑操作 type Google Chrome');
  });

  it('falls back to action only when no target is present', () => {
    expect(buildSingleToolLabel('computer_use', {
      action: 'observe',
    })).toBe('电脑操作 observe');
  });
});
