import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Plug } from 'lucide-react';
import {
  WorkbenchHistoryRow,
  WorkbenchLabelStack,
  WorkbenchPill,
  WorkbenchReferenceRow,
  WorkbenchSectionLabel,
  WorkbenchSelectablePill,
} from '../../../src/renderer/components/TaskPanel/WorkbenchPrimitives';

describe('TaskPanel WorkbenchPrimitives', () => {
  it('renders section labels and history rows with shared presentation', () => {
    const html = renderToStaticMarkup(
      React.createElement('div', null,
        React.createElement(WorkbenchSectionLabel, {
          icon: React.createElement(Plug, { className: 'w-3 h-3 text-sky-400' }),
          label: 'Connectors',
          count: 2,
        }),
        React.createElement(WorkbenchHistoryRow, {
          item: {
            kind: 'connector',
            id: 'mail',
            label: 'Mail',
            count: 2,
            topActions: [],
          },
          summary: 'send · draft',
        }),
      ),
    );

    expect(html).toContain('Connectors');
    expect(html).toContain('Mail');
    expect(html).toContain('send · draft');
    expect(html).toContain('2x');
  });

  it('renders shared label stacks and reference badges', () => {
    const html = renderToStaticMarkup(
      React.createElement('div', null,
        React.createElement(WorkbenchLabelStack, {
          label: 'review-skill',
          secondary: 'Review code changes',
          title: 'review-skill',
        }),
        React.createElement(WorkbenchReferenceRow, {
          reference: {
            kind: 'skill',
            id: 'draft-skill',
            label: 'draft-skill',
            description: 'Draft release notes',
            source: 'library',
            mounted: false,
            installState: 'available',
          },
          locale: 'zh',
          onOpenDetails: () => undefined,
        }),
      ),
    );

    expect(html).toContain('review-skill');
    expect(html).toContain('Review code changes');
    expect(html).toContain('draft-skill');
    expect(html).toContain('可挂载');
    expect(html).toContain('查看 draft-skill 详情');
  });

  it('renders shared workbench pills for display and selection states', () => {
    const html = renderToStaticMarkup(
      React.createElement('div', null,
        React.createElement(WorkbenchPill, {
          tone: 'connector',
        }, 'Connector mail'),
        React.createElement(WorkbenchSelectablePill, {
          tone: 'skill',
          selected: true,
          dimmed: true,
        }, 'review-skill'),
      ),
    );

    expect(html).toContain('Connector mail');
    expect(html).toContain('review-skill');
    expect(html).toContain('border-sky-500/20');
    expect(html).toContain('border-fuchsia-500/40');
    expect(html).toContain('opacity-60');
  });
});
