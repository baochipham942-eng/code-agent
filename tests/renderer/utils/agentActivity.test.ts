import { describe, expect, it } from 'vitest';
import { describeLastToolStep } from '../../../src/renderer/utils/agentActivity';
import { zh } from '../../../src/renderer/i18n/zh';

describe('describeLastToolStep', () => {
  it('uses the existing humanizeToolStep vocabulary when a step exists', () => {
    expect(describeLastToolStep({
      tool: 'Read',
      target: '/repo/spec.md',
      at: 1,
    }, zh)).toBe('读取了 /repo/spec.md');
  });

  it('uses the neutral i18n waiting sentence when no step exists', () => {
    expect(describeLastToolStep(undefined, zh)).toBe('正在整理任务…');
  });

  it('humanizes agent conversation through the same vocabulary', () => {
    expect(describeLastToolStep({
      tool: 'agent_message',
      target: '研究代理',
      at: 1,
    }, zh)).toBe('正在跟 研究代理 说话');
  });
});
