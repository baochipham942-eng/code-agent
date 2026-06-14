import { describe, expect, it } from 'vitest';
import type { WorkspacePreviewItem } from '../../../src/shared/contract';
import {
  buildWorkspaceRevisionComparison,
  buildWorkspaceRevisionHistory,
  getComparableWorkspaceContent,
} from '../../../src/renderer/utils/workspaceRevisions';

function item(overrides: Partial<WorkspacePreviewItem>): WorkspacePreviewItem {
  return {
    id: 'item',
    kind: 'document',
    title: 'Draft',
    status: 'ready',
    createdAt: 100,
    source: { kind: 'message', label: 'Assistant' },
    ...overrides,
  };
}

describe('workspaceRevisions', () => {
  it('builds an artifact revision chain through parentId', () => {
    const v1 = item({
      id: 'artifact:v1',
      title: 'Draft v1',
      createdAt: 100,
      content: { text: 'hello' },
      revision: { artifactId: 'a1', version: 1 },
    });
    const v2 = item({
      id: 'artifact:v2',
      title: 'Draft v2',
      createdAt: 200,
      content: { text: 'hello world' },
      revision: { artifactId: 'a2', version: 2, parentId: 'a1' },
    });

    const history = buildWorkspaceRevisionHistory([v2, v1], v2);

    expect(history.map((entry) => entry.id)).toEqual(['artifact:v1', 'artifact:v2']);
  });

  it('returns comparable content for the selected revision and its parent', () => {
    const v1 = item({
      id: 'artifact:v1',
      title: 'Dashboard',
      createdAt: 100,
      content: { html: '<h1>Old</h1>' },
      revision: { artifactId: 'html-v1', version: 1 },
    });
    const v2 = item({
      id: 'artifact:v2',
      title: 'Dashboard',
      createdAt: 200,
      content: { html: '<h1>New</h1>' },
      revision: { artifactId: 'html-v2', version: 2, parentId: 'html-v1' },
    });

    const comparison = buildWorkspaceRevisionComparison([v1, v2], v2);

    expect(comparison).toMatchObject({
      previous: v1,
      current: v2,
      before: '<h1>Old</h1>',
      after: '<h1>New</h1>',
      beforeLabel: 'HTML',
      afterLabel: 'HTML',
    });
  });

  it('formats JSON content before diffing', () => {
    const parsed = getComparableWorkspaceContent(item({
      content: { json: '{"b":2,"a":1}' },
    }));

    expect(parsed).toEqual({
      label: 'JSON',
      value: '{\n  "b": 2,\n  "a": 1\n}',
    });
  });

  it('does not invent a comparison for file-only revisions', () => {
    const v1 = item({
      id: 'file:v1',
      file: { path: '/tmp/report.docx' },
      revision: { artifactId: 'doc-v1', version: 1 },
    });
    const v2 = item({
      id: 'file:v2',
      file: { path: '/tmp/report.docx' },
      revision: { artifactId: 'doc-v2', version: 2, parentId: 'doc-v1' },
    });

    expect(buildWorkspaceRevisionComparison([v1, v2], v2)).toBeNull();
  });
});
