import { describe, expect, it } from 'vitest';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { computerLabelArgs, humanizeToolStep } from '../../../src/renderer/utils/humanizeToolStep';
import {
  computerUseObservedTarget,
  recordTarget,
} from '../../../src/host/tools/vision/computerUseTargetLease';

describe('computer running label', () => {
  it('names the app when the step or the lease knows it, and stays generic otherwise', () => {
    expect(humanizeToolStep('computer_use', {
      action: 'type',
      targetApp: 'Notes',
      text: 'secret',
    }, zh, undefined, 'running')).toBe('正在操作：Notes');
    expect(humanizeToolStep('computer_use', {
      action: 'type',
      targetApp: 'Notes',
    }, en, undefined, 'running')).toBe('Operating: Notes');

    expect(humanizeToolStep('computer_use', { action: 'type' }, zh, undefined, 'running')).toBe('正在操作电脑');
    expect(humanizeToolStep('computer_use', { action: 'type' }, en, undefined, 'running')).toBe('Controlling the computer');
    expect(humanizeToolStep('computer_use', {
      action: 'click',
      selector: '#save',
    }, zh, undefined, 'running')).toBe('正在操作电脑 · #save');

    const id = {
      sessionId: 'label-session',
      turnId: 'label-turn',
      agentId: 'label-agent',
    };
    recordTarget(id, { action: 'open_application', targetApp: 'Notes' });
    const leased = computerUseObservedTarget('computer_use', { action: 'type', text: 'hi' }, id);
    expect(humanizeToolStep(
      'computer_use',
      computerLabelArgs({ action: 'type', text: 'hi' }, leased),
      zh,
      undefined,
      'running',
    )).toBe('正在操作：Notes');
    expect(humanizeToolStep(
      'computer_use',
      computerLabelArgs({ action: 'key', key: 'enter' }, leased),
      en,
      undefined,
      'running',
    )).toBe('Operating: Notes');
  });
});
