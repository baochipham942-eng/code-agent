import { describe, expect, it } from 'vitest';
import { summarizeManagedBrowserRecoverySnapshotData } from '../../../src/main/ipc/desktop.ipc';

describe('desktop recovery snapshot summaries', () => {
  it('returns recovery evidence summaries without raw DOM or Accessibility payloads', () => {
    const result = summarizeManagedBrowserRecoverySnapshotData({
      session: {
        running: true,
        tabCount: 1,
        mode: 'headless',
        provider: 'system-chrome-cdp',
        activeTab: {
          id: 'tab-1',
          title: 'Account',
          url: 'https://example.test/account?token=abc',
        },
        lastTrace: {
          params: {
            text: 'secret@example.com',
          },
        },
      },
      domSnapshot: {
        headings: [{ text: 'secret@example.com' }],
        interactiveElements: [{ text: 'secret@example.com' }, { text: 'Submit' }],
        rawHtml: '<input value="secret@example.com">',
      },
      accessibilitySnapshot: {
        role: 'WebArea',
        name: 'secret@example.com',
        children: [{ role: 'textbox', name: 'secret@example.com' }],
      },
    });

    expect(result).toMatchObject({
      session: {
        running: true,
        tabCount: 1,
        mode: 'headless',
        provider: 'system-chrome-cdp',
        activeTab: {
          title: 'Account',
          url: 'https://example.test/account',
        },
      },
      domSnapshot: {
        headingCount: 1,
        interactiveCount: 2,
      },
      accessibilitySnapshot: {
        available: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret@example.com');
    expect(JSON.stringify(result)).not.toContain('token=abc');
    expect(JSON.stringify(result)).not.toContain('rawHtml');
    expect(JSON.stringify(result)).not.toContain('children');
    expect(JSON.stringify(result)).not.toContain('lastTrace');
  });

  it('redacts opaque browser URLs that can carry inline content in the path', () => {
    const result = summarizeManagedBrowserRecoverySnapshotData({
      session: {
        running: true,
        activeTab: {
          title: 'secret@example.com',
          url: 'data:text/html;charset=utf-8,%3Cinput%20value%3Dsecret%40example.com%3E',
        },
      },
      domSnapshot: null,
      accessibilitySnapshot: null,
    });

    expect(result).toMatchObject({
      session: {
        activeTab: {
          title: '[redacted title]',
          url: 'data:[redacted]',
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('%3Cinput');
    expect(JSON.stringify(result)).not.toContain('text/html');
  });
});
