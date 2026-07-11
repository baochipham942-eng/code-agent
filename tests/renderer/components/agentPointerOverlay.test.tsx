// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { act } from '@testing-library/react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentPointerEvent } from '../../../src/shared/contract';
import {
  AgentPointerGlyph,
  AgentPointerOverlay,
  AgentPointerPreviewCard,
  AgentPointerTimelineList,
} from '../../../src/renderer/components/workbench/AgentPointerOverlay';

const event: AgentPointerEvent = {
  id: 'pointer-test',
  surface: 'computer',
  tone: 'computer',
  phase: 'click',
  coordSpace: 'surfacePreview',
  point: { x: 42, y: 46, unit: 'percent' },
  targetLabel: 'Finder',
  targetSource: 'fallback',
  traceId: 'trace-test',
  success: true,
};

describe('AgentPointerOverlay', () => {
  it('renders the Neo pointer glyph with tone color', () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentPointerGlyph, { tone: 'browser', phase: 'click' }),
    );

    expect(html).toContain('<svg');
    expect(html).toContain('#38BDF8');
  });

  it('renders a positioned overlay with click label', () => {
    const html = renderToStaticMarkup(
      React.createElement('div', { className: 'relative' },
        React.createElement(AgentPointerOverlay, { event }),
      ),
    );

    expect(html).toContain('aria-label="Computer click');
    expect(html).toContain('left:42%');
    expect(html).toContain('top:46%');
    expect(html).toContain('Finder');
  });

  it('applies spring transition for continuous movement between action points', () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentPointerOverlay, { event }),
    );

    expect(html).toContain('transition:left 560ms');
  });

  it('dims pointer and hides label/ring when not live (idle retention)', () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentPointerOverlay, { event, live: false }),
    );

    expect(html).toContain('opacity:0.38');
    // aria-label 保留完整描述，但可见标签 span 和点击脉冲环隐藏
    expect(html).not.toContain('backdrop-blur-xs');
    expect(html).not.toContain('animate-ping');
  });

  it('retains the positioning div across move/click/move rerenders', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderEvent = (nextEvent: AgentPointerEvent) => {
      act(() => {
        root.render(React.createElement(AgentPointerOverlay, { event: nextEvent }));
      });
      const overlay = container.firstElementChild;
      const positioningDiv = Array.from(overlay?.children ?? [])
        .find((child) => child.tagName === 'DIV');
      expect(positioningDiv).toBeInstanceOf(HTMLDivElement);
      return positioningDiv as HTMLDivElement;
    };

    try {
      const firstDiv = renderEvent({
        ...event,
        id: 'move-1',
        phase: 'move',
        point: { x: 10, y: 20, unit: 'percent' },
      });
      const clickDiv = renderEvent({
        ...event,
        id: 'click-1',
        phase: 'click',
        point: { x: 30, y: 40, unit: 'percent' },
      });
      const secondMoveDiv = renderEvent({
        ...event,
        id: 'move-2',
        phase: 'move',
        point: { x: 50, y: 60, unit: 'percent' },
      });

      expect(clickDiv).toBe(firstDiv);
      expect(secondMoveDiv).toBe(firstDiv);
      expect(secondMoveDiv.style.left).toBe('50%');
      expect(secondMoveDiv.style.top).toBe('60%');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('renders preview card chrome around the same pointer', () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentPointerPreviewCard, {
        event,
        title: 'Agent pointer',
        detail: 'Preview',
      }),
    );

    expect(html).toContain('Agent pointer');
    expect(html).toContain('Preview');
    expect(html).toContain('computer');
  });

  it('renders recent pointer timeline entries', () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentPointerTimelineList, {
        entries: [{
          event,
          receivedAtMs: 1,
          visibleUntilMs: 1000,
        }],
      }),
    );

    expect(html).toContain('Pointer timeline');
    expect(html).toContain('Finder');
    expect(html).toContain('<svg');
  });
});
