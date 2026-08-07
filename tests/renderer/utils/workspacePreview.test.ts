import { describe, expect, it } from 'vitest';
import type { Message, PermissionRequest } from '../../../src/shared/contract';
import {
  buildWorkspacePreviewHtmlSrcdoc,
  buildWorkspacePreviewSections,
} from '../../../src/renderer/utils/workspacePreview';

describe('buildWorkspacePreviewSections', () => {
  it('keeps an early-run artifact and a late-run file visible in the same session projection', () => {
    const early: Message = {
      id: 'early-artifact',
      role: 'assistant',
      content: '',
      timestamp: 1,
      artifacts: [{
        id: 'first-document',
        type: 'document',
        title: 'first-run.md',
        content: '# First run',
        version: 1,
      }],
    };
    const filler: Message[] = Array.from({ length: 65 }, (_, index) => ({
      id: `filler-${index}`,
      role: 'assistant' as const,
      content: `round ${index}`,
      timestamp: index + 2,
    }));
    const late: Message = {
      id: 'late-file',
      role: 'assistant',
      content: '',
      timestamp: 100,
      toolCalls: [{
        id: 'read-late',
        name: 'Write',
        arguments: { path: 'package.json' },
        result: {
          toolCallId: 'read-late',
          success: true,
          outputPath: 'package.json',
          output: 'ok',
        },
      }],
    };

    const { items } = buildWorkspacePreviewSections({
      messages: [early, ...filler, late],
      workingDirectory: '/repo',
    });

    expect(items.map((item) => item.title)).toEqual(expect.arrayContaining([
      'first-run.md',
      'package.json',
    ]));
  });

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

    const { items } = buildWorkspacePreviewSections({ messages });

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

    const { items } = buildWorkspacePreviewSections({
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
                  // 角色轴（2026-08-07）：kind=text 默认归 material，Write 在产出侧显式标 deliverable
                  role: 'deliverable',
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

    const { items } = buildWorkspacePreviewSections({ messages });
    const htmlItem = items.find((i) => i.title === 'index.html');
    expect(htmlItem).toBeTruthy();
    expect(htmlItem).toMatchObject({
      kind: 'generic_html',
      file: { path: '/Users/x/.code-agent/work/todo-app/index.html' },
    });
  });

  it('preserves rich tool artifact metadata for preview evidence', () => {
    const messages: Message[] = [
      {
        id: 'msg-image',
        role: 'assistant',
        content: '',
        timestamp: 320,
        toolCalls: [
          {
            id: 'tool-image',
            name: 'image_generate',
            arguments: {},
            result: {
              toolCallId: 'tool-image',
              success: true,
              metadata: {
                artifacts: [
                  {
                    artifactId: 'artifact-hero',
                    kind: 'image',
                    sourceTool: 'image_generate',
                    name: 'Hero preview',
                    path: 'out/hero.png',
                    mimeType: 'image/png',
                    sizeBytes: 2048,
                    sha256: 'b'.repeat(64),
                  },
                ],
              },
            },
          },
        ],
      },
    ];

    const { items } = buildWorkspacePreviewSections({
      messages,
      workingDirectory: '/repo/app',
    });

    expect(items[0]).toMatchObject({
      id: 'file:/repo/app/out/hero.png',
      kind: 'image',
      title: 'Hero preview',
      subtitle: 'image_generate',
      file: {
        path: '/repo/app/out/hero.png',
        name: 'Hero preview',
        mimeType: 'image/png',
        size: 2048,
        sha256: 'b'.repeat(64),
      },
    });
  });

  it('projects historical structured tool URL artifacts into Workspace Preview items', () => {
    const messages: Message[] = [
      {
        id: 'msg-url',
        role: 'assistant',
        content: '',
        timestamp: 320,
        toolCalls: [
          {
            id: 'tool-deploy',
            name: 'Deploy',
            arguments: {},
            result: {
              toolCallId: 'tool-deploy',
              success: true,
              metadata: {
                artifact: {
                  artifactId: 'preview-url',
                  kind: 'web',
                  sourceTool: 'Deploy',
                  name: 'Preview URL',
                  url: 'https://example.com/app',
                },
              },
            },
          },
        ],
      },
    ];

    // 角色轴（2026-08-07）：kind=web 默认归 material——历史 URL 产物不再进产物列表，
    // 而是进「过程材料」区（与聊天流「来源」同一判据，web 口径不一致在此修掉）。
    const { items, materialItems } = buildWorkspacePreviewSections({ messages });

    expect(items).toEqual([]);
    expect(materialItems).toContainEqual(expect.objectContaining({
      id: 'tool-artifact:tool-deploy:preview-url',
      kind: 'web_snapshot',
      title: 'Preview URL',
      content: {
        summary: 'https://example.com/app',
      },
    }));
  });

  it('projects artifact revision and quality metadata onto workspace preview items', () => {
    const messages: Message[] = [
      {
        id: 'msg-quality',
        role: 'assistant',
        content: '',
        timestamp: 330,
        toolCalls: [
          {
            id: 'tool-quality',
            name: 'Write',
            arguments: {},
            result: {
              toolCallId: 'tool-quality',
              success: true,
              metadata: {
                artifacts: [
                  {
                    artifactId: 'artifact-html-v3',
                    kind: 'text',
                    // 角色轴：同上，Write 产出侧显式标 deliverable
                    role: 'deliverable',
                    sourceTool: 'Write',
                    name: 'index.html',
                    path: 'dist/index.html',
                    mimeType: 'text/html',
                    sha256: 'c'.repeat(64),
                    metadata: {
                      version: 3,
                      parentArtifactId: 'artifact-html-v2',
                      changeSummary: 'Reworked hero layout',
                      artifactIssues: [
                        {
                          issueId: 'issue-1',
                          status: 'open',
                          severity: 'high',
                          title: 'Mobile smoke failed',
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    ];

    const { items } = buildWorkspacePreviewSections({
      messages,
      workingDirectory: '/repo/app',
    });

    expect(items[0]).toMatchObject({
      id: 'file:/repo/app/dist/index.html:artifact-html-v3',
      revision: {
        artifactId: 'artifact-html-v3',
        version: 3,
        parentId: 'artifact-html-v2',
        parentRef: 'artifact:artifact-html-v2',
        filePath: '/repo/app/dist/index.html',
        sha256: 'c'.repeat(64),
        sourceTool: 'Write',
        changeSummary: 'Reworked hero layout',
      },
      quality: {
        status: 'failed',
        summary: 'Mobile smoke failed',
        issueCount: 1,
        blocking: true,
      },
    });
  });

  it('keeps versioned file artifacts with the same path as separate revision items', () => {
    const messages: Message[] = [
      {
        id: 'msg-v1',
        role: 'assistant',
        content: '',
        timestamp: 100,
        toolCalls: [
          {
            id: 'tool-v1',
            name: 'Write',
            arguments: {},
            result: {
              toolCallId: 'tool-v1',
              success: true,
              metadata: {
                artifacts: [
                  {
                    artifactId: 'report-v1',
                    kind: 'document',
                    sourceTool: 'Write',
                    path: 'reports/final.md',
                    metadata: { version: 1 },
                  },
                ],
              },
            },
          },
        ],
      },
      {
        id: 'msg-v2',
        role: 'assistant',
        content: '',
        timestamp: 200,
        toolCalls: [
          {
            id: 'tool-v2',
            name: 'Edit',
            arguments: {},
            result: {
              toolCallId: 'tool-v2',
              success: true,
              metadata: {
                artifacts: [
                  {
                    artifactId: 'report-v2',
                    kind: 'document',
                    sourceTool: 'Edit',
                    path: 'reports/final.md',
                    metadata: {
                      version: 2,
                      parentArtifactId: 'report-v1',
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    ];

    const { items } = buildWorkspacePreviewSections({
      messages,
      workingDirectory: '/repo/app',
    });

    expect(items.filter((item) => item.file?.path === '/repo/app/reports/final.md')).toHaveLength(2);
    expect(items.map((item) => item.id)).toContain('file:/repo/app/reports/final.md:report-v1');
    expect(items.map((item) => item.id)).toContain('file:/repo/app/reports/final.md:report-v2');
  });

  it('classifies media, office, and archive file artifacts for the preview matrix', () => {
    const messages: Message[] = [
      {
        id: 'msg-matrix',
        role: 'assistant',
        content: '',
        timestamp: 340,
        toolCalls: [
          {
            id: 'tool-matrix',
            name: 'asset_tool',
            arguments: {},
            result: {
              toolCallId: 'tool-matrix',
              success: true,
              metadata: {
                artifacts: [
                  { artifactId: 'a-image', kind: 'image', sourceTool: 'asset_tool', path: 'assets/hero.png' },
                  { artifactId: 'a-audio', kind: 'audio', sourceTool: 'asset_tool', path: 'assets/voice.mp3' },
                  { artifactId: 'a-video', kind: 'video', sourceTool: 'asset_tool', path: 'assets/demo.mp4' },
                  { artifactId: 'a-docx', kind: 'document', sourceTool: 'asset_tool', path: 'docs/brief.docx' },
                  { artifactId: 'a-xlsx', kind: 'spreadsheet', sourceTool: 'asset_tool', path: 'data/model.xlsx' },
                  { artifactId: 'a-deck', kind: 'document', sourceTool: 'asset_tool', path: 'deck/pitch.pptx' },
                  { artifactId: 'a-zip', kind: 'binary', sourceTool: 'asset_tool', path: 'bundle/site.zip' },
                ],
              },
            },
          },
        ],
      },
    ];

    const { items } = buildWorkspacePreviewSections({
      messages,
      workingDirectory: '/repo/app',
    });

    expect(items.map((item) => [item.title, item.kind, item.actions?.[0]?.label])).toEqual([
      ['hero.png', 'image', 'Preview'],
      ['voice.mp3', 'audio', 'Preview'],
      ['demo.mp4', 'video', 'Preview'],
      ['brief.docx', 'document', 'Preview'],
      ['model.xlsx', 'spreadsheet', 'Preview'],
      ['pitch.pptx', 'presentation', 'Preview'],
      ['site.zip', 'archive', 'Preview'],
    ]);
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

    const { items } = buildWorkspacePreviewSections({
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
    const { items } = buildWorkspacePreviewSections({
      messages: [],
      workingDirectory: '/repo/app',
      currentTurnArtifacts: {
        turnNumber: 4,
        artifactOwnership: [
          {
            kind: 'file',
            role: 'deliverable' as const,
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

  // e2e（workbench-overview-preview-first 的「有产物」那条）在真实链路上抓到的：当轮产出一个
  // 助手产物时，ownership 会造一条同名的无内容 trace 条目、priority 70 压过带正文的 40，
  // 右栏默认那一屏于是显示「暂无预览内容」，切换器还把一个产物算成两个。
  it('drops the contentless current-turn duplicate so the默认那一屏 keeps the artifact body', () => {
    const { items } = buildWorkspacePreviewSections({
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          content: '',
          timestamp: 100,
          artifacts: [
            { id: 'diagram-1', type: 'mermaid', title: '第一版流程图', content: 'graph TD; A-->B;', version: 1 },
          ],
        },
      ],
      currentTurnArtifacts: {
        turnNumber: 1,
        artifactOwnership: [
          {
            kind: 'artifact',
            role: 'deliverable' as const,
            label: '第一版流程图',
            ownerKind: 'assistant',
            ownerLabel: 'Assistant',
            sourceNodeId: 'msg-1-text',
          },
        ],
      },
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'artifact:msg-1:diagram-1',
      content: { text: 'graph TD; A-->B;' },
    });
  });

  it('keeps a contentless current-turn artifact when nothing else carries that artifact', () => {
    const { items } = buildWorkspacePreviewSections({
      messages: [],
      currentTurnArtifacts: {
        turnNumber: 1,
        artifactOwnership: [
          {
            kind: 'artifact',
            role: 'deliverable' as const,
            label: '子代理产物',
            ownerKind: 'assistant',
            ownerLabel: 'Assistant',
            sourceNodeId: 'node-9',
          },
        ],
      },
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'trace', title: '子代理产物' });
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
