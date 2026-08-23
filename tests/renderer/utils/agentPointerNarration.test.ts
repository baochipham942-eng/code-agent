import { describe, expect, it } from 'vitest';
import type { AgentPointerEvent } from '../../../src/shared/contract';
import { workbenchTabsEn, workbenchTabsZh } from '../../../src/renderer/i18n/workbenchTabs';
import { getAgentPointerNarration } from '../../../src/renderer/utils/agentPointerNarration';

const baseEvent: AgentPointerEvent = {
  id: 'narration-test',
  surface: 'browser',
  tone: 'browser',
  phase: 'click',
  coordSpace: 'browserViewport',
  targetLabel: '提交按钮',
  targetSource: 'targetRef',
  success: true,
};

const zh = workbenchTabsZh.workbenchTabs.agentWindow.pointerNarration;
const en = workbenchTabsEn.workbenchTabs.agentWindow.pointerNarration;

describe('agent pointer narration', () => {
  it.each([
    ['navigate', '携程订票页', '正在打开 携程订票页'],
    ['click', '8/20 上海→北京的航班', '正在点击 8/20 上海→北京的航班'],
    ['type', '出发城市', '正在填写 出发城市'],
    ['wait', '航班搜索结果', '正在等待 航班搜索结果'],
  ] as const)('renders a Chinese sentence for %s', (phase, targetLabel, expected) => {
    expect(getAgentPointerNarration({ ...baseEvent, phase, targetLabel }, zh)).toBe(expected);
  });

  it('uses the English i18n copy for the same event', () => {
    expect(getAgentPointerNarration({
      ...baseEvent,
      phase: 'navigate',
      targetLabel: 'https://flights.example.com/search?token=hidden',
    }, en)).toBe('Opening flights.example.com/search');
    expect(getAgentPointerNarration({ ...baseEvent, phase: 'wait', targetLabel: null }, en))
      .toBe('Waiting for the page to respond');
  });

  it.each([
    ['#checkout > button:nth-child(2)', 'selector'],
    ['//html/body/div[2]/button', 'selector'],
    ['/html/body/main/div/button', 'axPath'],
    ['axPath 1.2.4', 'axPath'],
    ['targetRef target-42', 'targetRef'],
    ['340,220', 'coordinate'],
  ] as const)('filters internal target %s and falls back to action-level copy', (targetLabel, targetSource) => {
    const unsafeEvent: AgentPointerEvent = {
      ...baseEvent,
      targetLabel,
      targetSource,
    };
    expect(getAgentPointerNarration(unsafeEvent, zh)).toBe('正在点击页面');
  });

  it('keeps a human-readable name even when legacy metadata classified it as selector-sourced', () => {
    const legacyEvent: AgentPointerEvent = {
      ...baseEvent,
      targetLabel: '提交订单',
      targetSource: 'selector',
    };
    expect(getAgentPointerNarration(legacyEvent, zh)).toBe('正在点击 提交订单');
  });
});
