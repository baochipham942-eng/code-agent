// ============================================================================
// 角色轴回归红线（ADR-055）
// ----------------------------------------------------------------------------
// 角色轴对 kind='text' 是 fail-closed（默认 material），代价是**漏标 = 文件从产物里
// 静默消失**，比"漏进产物"更难被发现。这里逐条钉死两组红线：
//
//   组 A（必须仍在产物里）：docx / xlsx / pptx / 图片 / zip 导出包 / Write 写的文件 / .ipynb
//   组 B（必须不在产物里）：web_fetch 抓的网页 / memoryWrite 写的记忆 / youtube 源视频 /
//                          read 等只读工具的读取内容
//
// 两条通路都要断言：聊天流（buildArtifactOwnershipItems）与概览
// （buildWorkspacePreviewSections）共用同一判据 isDeliverableArtifact，
// 任一条漏了都说明"同一个决策漏了一处实现"的老病复发。
//
// ⚠️ 本文件的夹具**手写 role 值**，测的是消费端分流；产出点到底有没有设 role
// 由 tests/unit/artifacts/deliverableRoleAnnotations.contract.test.ts 那道静态门守。
// 两者缺一不可——2026-08-07 实测：只有本文件时，撤掉 notebookEdit 的标注照样全绿。
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import { buildArtifactOwnershipItems } from '../../../src/renderer/utils/artifactOwnership';
import { buildWorkspacePreviewSections } from '../../../src/renderer/utils/workspacePreview';

type ToolArtifactFixture = {
  artifactId: string;
  kind: string;
  role?: string;
  sourceTool: string;
  name?: string;
  path?: string;
  url?: string;
};

function turnWith(toolName: string, metadata: Record<string, unknown>): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status: 'completed',
    startTime: 100,
    endTime: 140,
    nodes: [
      { id: 'user-1', type: 'user', content: '干活', timestamp: 100 },
      {
        id: 'tool-1',
        type: 'tool_call',
        content: '',
        timestamp: 120,
        toolCall: { id: 'tool-1', name: toolName, args: {}, result: 'ok', success: true, metadata },
      },
    ],
  };
}

function messagesWith(toolName: string, metadata: Record<string, unknown>): Message[] {
  return [{
    id: 'msg-1',
    role: 'assistant',
    content: '',
    timestamp: 120,
    toolCalls: [{
      id: 'tool-1',
      name: toolName,
      arguments: {},
      result: { toolCallId: 'tool-1', success: true, metadata },
    }],
  }] as Message[];
}

/** 聊天流分流结果 */
function chatSplit(toolName: string, artifact: ToolArtifactFixture) {
  const items = buildArtifactOwnershipItems(turnWith(toolName, { artifact }));
  return {
    deliverables: items.filter((i) => i.role !== 'material'),
    materials: items.filter((i) => i.role === 'material'),
  };
}

/** 概览分流结果 */
function overviewSplit(toolName: string, artifact: ToolArtifactFixture) {
  return buildWorkspacePreviewSections({
    messages: messagesWith(toolName, { artifact }),
    workingDirectory: '/repo/app',
  });
}

// ── 组 A：必须仍在产物里 ────────────────────────────────────────────────────

const MUST_STAY: Array<[string, string, ToolArtifactFixture]> = [
  ['docx（document）', 'office_write', {
    artifactId: 'a-docx', kind: 'document', sourceTool: 'office_write', path: '/repo/app/brief.docx',
  }],
  ['xlsx（spreadsheet）', 'excel_automate', {
    artifactId: 'a-xlsx', kind: 'spreadsheet', sourceTool: 'excel_automate', path: '/repo/app/model.xlsx',
  }],
  ['pptx（document）', 'ppt_generate', {
    artifactId: 'a-pptx', kind: 'document', sourceTool: 'ppt_generate', path: '/repo/app/deck.pptx',
  }],
  ['生成的图片（image）', 'image_generate', {
    artifactId: 'a-img', kind: 'image', sourceTool: 'image_generate', path: '/repo/app/hero.png',
  }],
  // 🔴 初版规格把 binary 划成 material，被这条抓到（site.zip 从产物消失）
  ['zip 导出包（binary）', 'export_bundle', {
    artifactId: 'a-zip', kind: 'binary', sourceTool: 'export_bundle', path: '/repo/app/site.zip',
  }],
  ['Write 写的文件（text + 显式 deliverable）', 'Write', {
    artifactId: 'a-html', kind: 'text', role: 'deliverable', sourceTool: 'Write', path: '/repo/app/index.html',
  }],
  ['.ipynb（text + 显式 deliverable）', 'notebook_edit', {
    artifactId: 'a-nb', kind: 'text', role: 'deliverable', sourceTool: 'notebook_edit', path: '/repo/app/分析.ipynb',
  }],
];

describe('角色轴红线 · 组 A：这些必须仍在产物里', () => {
  it.each(MUST_STAY)('%s —— 聊天流产物区', (_label, tool, artifact) => {
    const { deliverables, materials } = chatSplit(tool, artifact);
    expect(deliverables.map((i) => i.path)).toEqual([artifact.path]);
    expect(materials).toEqual([]);
  });

  it.each(MUST_STAY)('%s —— 概览产物区', (_label, tool, artifact) => {
    const { items, materialItems } = overviewSplit(tool, artifact);
    expect(items.map((i) => i.file?.path)).toEqual([artifact.path]);
    expect(materialItems).toEqual([]);
  });
});

// ── 组 B：必须不在产物里 ────────────────────────────────────────────────────

const MUST_NOT_STAY: Array<[string, string, ToolArtifactFixture]> = [
  ['web_fetch 抓的网页（web）', 'web_fetch', {
    artifactId: 'a-web', kind: 'web', sourceTool: 'web_fetch', name: 'example.com', url: 'https://example.com/a',
  }],
  ['memoryWrite 写的记忆（text 默认 material）', 'memory_write', {
    artifactId: 'a-mem', kind: 'text', sourceTool: 'memory_write', path: '/repo/app/.memory/note.md',
  }],
  ['youtube 源视频 url（text 默认 material）', 'youtube_transcript', {
    artifactId: 'a-yt', kind: 'text', sourceTool: 'youtube_transcript', name: '源视频', url: 'https://youtube.com/watch?v=x',
  }],
  ['搜索结果（search）', 'web_search', {
    artifactId: 'a-search', kind: 'search', sourceTool: 'web_search', name: '搜索结果', url: 'https://search/q',
  }],
  ['命令输出（process-output）', 'bash', {
    artifactId: 'a-out', kind: 'process-output', sourceTool: 'bash', name: 'stdout', path: '/repo/app/out.log',
  }],
];

describe('角色轴红线 · 组 B：这些必须不在产物里', () => {
  it.each(MUST_NOT_STAY)('%s —— 聊天流降级进「来源」', (_label, tool, artifact) => {
    const { deliverables, materials } = chatSplit(tool, artifact);
    expect(deliverables).toEqual([]);
    expect(materials.length).toBe(1);
  });

  it.each(MUST_NOT_STAY)('%s —— 概览落「过程材料」而非产物', (_label, tool, artifact) => {
    const { items, materialItems } = overviewSplit(tool, artifact);
    expect(items).toEqual([]);
    expect(materialItems.length).toBe(1);
  });
});

// ── 口径一致性：两条通路对同一份东西必须给同一个答案 ──────────────────────

describe('角色轴 · 两条通路口径一致（web 不一致的老病不许复发）', () => {
  const webArtifact: ToolArtifactFixture = {
    artifactId: 'a-web', kind: 'web', sourceTool: 'web_fetch', name: 'example.com', url: 'https://example.com/a',
  };

  it('web_fetch 抓的网页：聊天流与概览都判它不是产物', () => {
    const chat = chatSplit('web_fetch', webArtifact);
    const overview = overviewSplit('web_fetch', webArtifact);

    // 这一条就是 ADR-055 背景里那个「同一个决策漏了一处实现」的形态
    expect(chat.deliverables).toEqual([]);
    expect(overview.items).toEqual([]);
  });
});

// ── 只读工具：读取内容不进产物（清单在 metadata 兜底通道上仍承重）──────────

describe('角色轴 · 未登记 / 缺失 kind 不得让产物消失', () => {
  // 🔴 回归：初版把未登记 kind 兜成 material，`kind: 'html'` 的 Write 产物直接从产物区蒸发。
  // 四个 material 类型全都显式登记，未登记的按定义不可能是过程材料；而 normalize 在
  // kind 缺失时会填 'artifact'，兜 material 等于让所有没写 kind 的真产物消失。
  it('未登记的 kind（html）仍进产物', () => {
    const { deliverables } = chatSplit('Write', {
      artifactId: 'a-html', kind: 'html', sourceTool: 'Write', name: 'Preview', path: '/repo/app/preview.html',
    });
    expect(deliverables.map((i) => i.path)).toEqual(['/repo/app/preview.html']);
  });

  it('kind 缺失被 normalize 填成 artifact 时仍进产物', () => {
    const { deliverables } = chatSplit('Write', {
      artifactId: 'a-none', kind: 'artifact', sourceTool: 'Write', name: 'out.md', path: '/repo/app/out.md',
    });
    expect(deliverables.map((i) => i.path)).toEqual(['/repo/app/out.md']);
  });
});

describe('角色轴 · outputPath 与 metadata 路径的区别对待', () => {
  // 🔴 回归：收窄兜底通道时曾把 toolCall.outputPath 一起跳过，导致「既写文件又产 artifact」
  // 的工具丢掉那个文件。outputPath 是工具**声明的产出**，语义明确，不该被 artifact 的
  // 存在与否影响；模糊的是 metadata 里的 filePath/imagePath（可能是输入）。
  it('工具同时有 outputPath 和 artifact 时，outputPath 的文件仍进产物', () => {
    const turn = turnWith('report_tool', {
      artifact: {
        artifactId: 'a-img', kind: 'image', sourceTool: 'report_tool', path: '/repo/app/chart.png',
      },
    });
    turn.nodes[1].toolCall!.outputPath = '/repo/app/report.md';

    const paths = buildArtifactOwnershipItems(turn)
      .filter((i) => i.role === 'deliverable')
      .map((i) => i.path);

    expect(paths).toContain('/repo/app/report.md');
    expect(paths).toContain('/repo/app/chart.png');
  });

  it('产了 artifact 时，metadata.imagePath（可能是输入）不再兜底进产物', () => {
    const items = buildArtifactOwnershipItems(turnWith('image_analyze', {
      artifact: {
        artifactId: 'a-note', kind: 'text', sourceTool: 'image_analyze', path: '/repo/app/note.md',
      },
      imagePath: '/repo/app/source.png',
    }));

    expect(items.map((i) => i.path)).not.toContain('/repo/app/source.png');
  });
});

describe('角色轴 · 只读工具的读取路径不混进产物', () => {
  it('read 的 metadata.filePath 不生成产物条目', () => {
    const items = buildArtifactOwnershipItems(
      turnWith('read', { filePath: '/repo/app/src/index.ts' }),
    );
    expect(items).toEqual([]);
  });

  it('产了 material artifact 的调用，metadata 路径兜底通道不再另行扫描', () => {
    // imageAnalyze 读一张来源图：artifact 是 material，metadata 里还留着 imagePath。
    // 兜底通道若照扫，这张来源图会绕过角色判据混进产物。
    const items = buildArtifactOwnershipItems(turnWith('image_analyze', {
      artifact: {
        artifactId: 'a-src', kind: 'image', role: 'material',
        sourceTool: 'image_analyze', path: '/repo/app/source.png',
      },
      imagePath: '/repo/app/source.png',
    }));

    expect(items.filter((i) => i.role !== 'material')).toEqual([]);
  });
});
