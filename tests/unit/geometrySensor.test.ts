import { describe, expect, it } from 'vitest';
import { classifyRegion } from '../../tests/e2e/fixtures/geometrySensor';
import { caselistSensorOptions, sidebarSensorOptions } from '../../tests/e2e/fixtures/geometryScenarios';

describe('geometry sensor region attribution', () => {
  it('prefers explicit landmarks and falls back to stable test-id regions', () => {
    expect(classifyRegion('sidebar-session-scroll', null)).toBe('sidebar');
    expect(classifyRegion('chat-input', null)).toBe('composer');
    expect(classifyRegion('conversation-turn', null)).toBe('conversation');
    expect(classifyRegion('anything', 'sidebar')).toBe('sidebar');
    expect(classifyRegion('other', null)).toBe('other');
  });
});

describe('geometry sensor scenario options', () => {
  it('pins the sticky-header probe to the eval case list table', () => {
    expect(caselistSensorOptions.stickyHeaders).toEqual([
      { header: '[data-testid="eval-case-list-tab"] thead.sticky', rowSelector: '[data-testid^="eval-case-row-"]' },
    ]);
  });

  it('pins the gutter probe to a content-box right-edge comparison, not z-index cover', () => {
    expect(sidebarSensorOptions.rightEdgeAlignments?.[0]).toMatchObject({
      subject: '[data-testid="sidebar-session-scroll"]',
      siblings: ['[data-testid="sidebar-capability-zone"]'],
      maxOverhangPx: 1,
    });
    expect(sidebarSensorOptions.scrollContainers?.[0]?.selector).toBe('[data-testid="sidebar-session-scroll"]');
  });
});
