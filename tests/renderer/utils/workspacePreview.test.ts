import { describe, expect, it } from 'vitest';
import type { Message, PermissionRequest } from '../../../src/shared/contract';
import {
  buildWorkspacePreviewHtmlSrcdoc,
  buildWorkspacePreviewItems,
} from '../../../src/renderer/utils/workspacePreview';

describe('buildWorkspacePreviewItems', () => {
  it('collects assistant artifacts as previewable workspace items', () => {
    const messages: Message[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        content: '',
        timestamp: 100,
        artifacts: [
          {
            id: 'sheet-1',
            type: 'spreadsheet',
            title: 'Budget Sheet',
            content: '{"sheets":[]}',
            version: 2,
          },
          {
            id: 'ui-1',
            type: 'generative_ui',
            title: 'Landing Draft',
            content: '<section>Draft</section>',
            version: 1,
          },
        ],
      },
    ];

    const items = buildWorkspacePreviewItems({ messages });

    expect(items.map((item) => [item.kind, item.title])).toEqual([
      ['spreadsheet', 'Budget Sheet'],
      ['generic_html', 'Landing Draft'],
    ]);
    expect(items[0].content?.json).toBe('{"sheets":[]}');
    expect(items[1].content?.html).toBe('<section>Draft</section>');
  });

  it('collects tool preview metadata and file outputs with path dedupe', () => {
    const messages: Message[] = [
      {
        id: 'msg-2',
        role: 'assistant',
        content: '',
        timestamp: 200,
        toolCalls: [
          {
            id: 'tool-1',
            name: 'mail_draft',
            arguments: {},
            result: {
              toolCallId: 'tool-1',
              success: true,
              outputPath: 'report.md',
              metadata: {
                filePath: 'report.md',
                previewItem: {
                  kind: 'message_draft',
                  title: 'Follow-up Mail',
                  status: 'draft',
                  content: {
                    text: 'To: team@example.com\nSubject: Follow-up',
                  },
                },
              },
            },
          },
        ],
      },
    ];

    const items = buildWorkspacePreviewItems({
      messages,
      workingDirectory: '/repo/app',
    });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: 'message_draft',
      title: 'Follow-up Mail',
      status: 'draft',
      source: {
        kind: 'tool',
        toolName: 'mail_draft',
      },
    });
    expect(items[1]).toMatchObject({
      kind: 'document',
      title: 'report.md',
      file: {
        path: '/repo/app/report.md',
      },
    });
  });

  it('projects native Write artifacts from result.metadata (no top-level outputPath)', () => {
    // 复刻原生 Write 工具的真实结果形状：meta.outputPath / meta.artifact 落在
    // result.metadata 上，顶层 result.outputPath 不设（只有 MCP 工具才设顶层）。
    // 这是 Bug 2 的关键路径——正常 Write 多文件产物必须据此进产物面板。
    const messages: Message[] = [
      {
        id: 'msg-w',
        role: 'assistant',
        content: '',
        timestamp: 300,
        toolCalls: [
          {
            id: 'tool-w',
            name: 'Write',
            arguments: { file_path: '/Users/x/.code-agent/work/todo-app/index.html' },
            result: {
              toolCallId: 'tool-w',
              success: true,
              metadata: {
                outputPath: '/Users/x/.code-agent/work/todo-app/index.html',
                artifact: {
                  artifactId: 'a1',
                  kind: 'text',
                  sourceTool: 'Write',
                  name: 'index.html',
                  path: '/Users/x/.code-agent/work/todo-app/index.html',
                },
              },
            },
          },
        ],
      },
    ];

    const items = buildWorkspacePreviewItems({ messages });
    const htmlItem = items.find((i) => i.title === 'index.html');
    expect(htmlItem).toBeTruthy();
    expect(htmlItem).toMatchObject({
      kind: 'generic_html',
      file: { path: '/Users/x/.code-agent/work/todo-app/index.html' },
    });
  });

  it('surfaces permission diffs as draft preview items', () => {
    const request: PermissionRequest = {
      id: 'permission-1',
      type: 'file_edit',
      tool: 'Edit',
      timestamp: 300,
      details: {
        filePath: '/repo/app/src/app.ts',
        preview: {
          type: 'diff',
          summary: 'Edit app.ts',
          before: 'old',
          after: 'new',
          diff: '-old\n+new',
        },
      },
    };

    const items = buildWorkspacePreviewItems({
      messages: [],
      pendingPermissionRequest: request,
    });

    expect(items).toEqual([
      expect.objectContaining({
        id: 'permission:permission-1',
        kind: 'diff',
        title: 'Edit app.ts',
        status: 'draft',
        currentTurn: true,
        file: {
          path: '/repo/app/src/app.ts',
          name: 'app.ts',
        },
        content: expect.objectContaining({
          before: 'old',
          after: 'new',
          diff: '-old\n+new',
        }),
      }),
    ]);
  });

  it('collects current-turn artifact ownership and resolves relative paths', () => {
    const items = buildWorkspacePreviewItems({
      messages: [],
      workingDirectory: '/repo/app',
      currentTurnArtifacts: {
        turnNumber: 4,
        artifactOwnership: [
          {
            kind: 'file',
            label: 'out.csv',
            ownerKind: 'tool',
            ownerLabel: 'analyst · Write',
            path: 'exports/out.csv',
          },
        ],
      },
    });

    expect(items[0]).toMatchObject({
      id: 'turn-file:4:/repo/app/exports/out.csv',
      kind: 'spreadsheet',
      title: 'out.csv',
      currentTurn: true,
      file: {
        path: '/repo/app/exports/out.csv',
      },
    });
  });

  it('injects preview runtime before existing head scripts', () => {
    const srcdoc = buildWorkspacePreviewHtmlSrcdoc(
      '<html><head><script>localStorage.setItem("theme", "dark")</script></head><body><main>Draft</main></body></html>',
      { previewId: 'artifact:<draft>' },
    );

    expect(srcdoc.indexOf("installStorageShim('localStorage')"))
      .toBeLessThan(srcdoc.indexOf('localStorage.setItem("theme", "dark")'));
    expect(srcdoc).toContain("installStorageShim('sessionStorage')");
    expect(srcdoc).toContain('artifact:\\u003cdraft\\u003e');
  });

  it('adds sandbox runtime messages and resize nudges to HTML fragments', () => {
    const srcdoc = buildWorkspacePreviewHtmlSrcdoc('<section>Draft</section>');

    expect(srcdoc).toContain('<!DOCTYPE html>');
    expect(srcdoc).toContain("channel: 'workspace-preview'");
    expect(srcdoc).toContain("type: 'workspace-preview:status'");
    expect(srcdoc).toContain("type: 'workspace-preview:resize'");
    expect(srcdoc).toContain('new MutationObserver(nudgeResize)');
    expect(srcdoc).toContain('new ResizeObserver(nudgeResize)');
    expect(srcdoc).toContain('document.fonts.ready.then(nudgeResize)');
    expect(srcdoc).toContain('setTimeout(nudgeResize, 1000)');
  });
});
