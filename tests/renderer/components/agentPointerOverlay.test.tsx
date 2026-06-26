import React from 'react';
import { describe, expect, it } from 'vitest';
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
