// ============================================================================
// artifactRenderReview — docx/pdf/xlsx 渲染审查闸
// ============================================================================

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';

import {
  checkXlsxStructure,
  reviewRenderableDeliverables,
  runArtifactRenderReviewGate,
} from '../../../../src/host/agent/runtime/artifactRenderReview';
import { ARTIFACT_RENDER_REVIEW } from '../../../../src/shared/constants/agent';
import type { Message } from '../../../../src/shared/contract';
import { writeCleanDocx, writeOverflowDocx } from './artifactRenderReview.fixtures';

const workRoot = path.join(os.tmpdir(), `artifact-render-review-${process.pid}-${Date.now()}`);

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    role: 'user',
    content: '做一份报告',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

function producingActivity(filePath: string): Message {
  return {
    id: 'tool-activity',
    role: 'assistant',
    content: '',
    timestamp: 1_700_000_000_050,
    toolCalls: [{ id: 'write-1', name: 'Write', arguments: { file_path: filePath } }],
    toolResults: [{ toolCallId: 'write-1', success: true, output: 'ok', metadata: { outputPath: filePath } }],
  };
}

afterEach(() => {
  if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
});

describe('reviewRenderableDeliverables', () => {
  it('LibreOffice 缺失时跳过审查，status 为 skipped_no_libreoffice', async () => {
    mkdirSync(workRoot, { recursive: true });
    const filePath = path.join(workRoot, 'report.docx');
    await writeCleanDocx(filePath);

    const stamp = await reviewRenderableDeliverables([filePath], {
      libreOfficeAvailable: () => false,
      vlm: async () => {
        throw new Error('VLM must not run when LibreOffice is missing');
      },
    });

    expect(stamp.status).toBe('skipped_no_libreoffice');
    expect(stamp.issues).toEqual([]);
    expect(stamp.filesReviewed).toEqual([]);
  });

  it('VLM 指出文字溢出时 status=failed，带页码和 overflow', async () => {
    mkdirSync(workRoot, { recursive: true });
    const filePath = path.join(workRoot, 'overflow.docx');
    await writeOverflowDocx(filePath);
    writeFileSync(path.join(workRoot, 'page-1.jpg'), 'fake-image');

    const stamp = await reviewRenderableDeliverables([filePath], {
      libreOfficeAvailable: () => true,
      rasterize: async () => [path.join(workRoot, 'page-1.jpg')],
      vlm: async () => JSON.stringify({
        passed: false,
        issues: [{ kind: 'overflow', description: '右侧表格被裁切，最后一列看不见', severity: 'high' }],
      }),
    });

    expect(stamp.status).toBe('failed');
    expect(stamp.issues).toEqual([expect.objectContaining({
      file: filePath,
      page: 1,
      kind: 'overflow',
      description: '右侧表格被裁切，最后一列看不见',
      severity: 'high',
    })]);
  });

  it('VLM 空响应不假装通过，status 为 skipped_no_vlm', async () => {
    mkdirSync(workRoot, { recursive: true });
    const filePath = path.join(workRoot, 'clean.docx');
    await writeCleanDocx(filePath);
    writeFileSync(path.join(workRoot, 'page-1.jpg'), 'fake-image');

    const stamp = await reviewRenderableDeliverables([filePath], {
      libreOfficeAvailable: () => true,
      rasterize: async () => [path.join(workRoot, 'page-1.jpg')],
      vlm: async () => '',
    });

    expect(stamp.status).toBe('skipped_no_vlm');
  });

  it('干净文档 VLM 无问题 → passed', async () => {
    mkdirSync(workRoot, { recursive: true });
    const filePath = path.join(workRoot, 'clean.docx');
    await writeCleanDocx(filePath);
    writeFileSync(path.join(workRoot, 'page-1.jpg'), 'fake-image');

    const stamp = await reviewRenderableDeliverables([filePath], {
      libreOfficeAvailable: () => true,
      rasterize: async () => [path.join(workRoot, 'page-1.jpg')],
      vlm: async () => JSON.stringify({ passed: true, issues: [] }),
    });

    expect(stamp.status).toBe('passed');
    expect(stamp.issues).toEqual([]);
  });

  it('单次交付 VLM 调用不超过 MAX_VLM_CALLS_PER_DELIVERY', async () => {
    mkdirSync(workRoot, { recursive: true });
    const filePath = path.join(workRoot, 'many.pdf');
    writeFileSync(filePath, '%PDF-1.4');
    const pages = Array.from({ length: ARTIFACT_RENDER_REVIEW.MAX_PAGES + 5 }, (_, index) => {
      const pagePath = path.join(workRoot, `p-${index}.jpg`);
      writeFileSync(pagePath, 'img');
      return pagePath;
    });
    let calls = 0;
    await reviewRenderableDeliverables([filePath], {
      libreOfficeAvailable: () => true,
      rasterize: async () => pages,
      vlm: async () => {
        calls += 1;
        return '{"passed":true,"issues":[]}';
      },
    });
    expect(calls).toBe(ARTIFACT_RENDER_REVIEW.MAX_VLM_CALLS_PER_DELIVERY);
  });
});

describe('xlsx structure check', () => {
  it('空表（行列维度为零）记为 high 问题', async () => {
    mkdirSync(workRoot, { recursive: true });
    const filePath = path.join(workRoot, 'empty.xlsx');
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('空表');
    await workbook.xlsx.writeFile(filePath);
    const issues = await checkXlsxStructure(filePath);
    expect(issues.some((issue) => issue.description.includes('维度为零'))).toBe(true);
  });

  it('有数据的 sheet 不报空表', async () => {
    mkdirSync(workRoot, { recursive: true });
    const filePath = path.join(workRoot, 'ok.xlsx');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('数据');
    sheet.getCell('A1').value = '月份';
    sheet.getCell('A2').value = '一月';
    await workbook.xlsx.writeFile(filePath);
    expect(await checkXlsxStructure(filePath)).toEqual([]);
  });
});

describe('runArtifactRenderReviewGate', () => {
  it('溢出文档在补轮预算内回喂 repair', async () => {
    mkdirSync(workRoot, { recursive: true });
    const filePath = path.join(workRoot, 'overflow.docx');
    await writeOverflowDocx(filePath);
    writeFileSync(path.join(workRoot, 'page-1.jpg'), 'img');

    const result = await runArtifactRenderReviewGate({
      workingDirectory: workRoot,
      messages: [message(), producingActivity(filePath)],
      finalText: '已生成 `overflow.docx`。',
      repairsUsed: 0,
      deps: {
        libreOfficeAvailable: () => true,
        rasterize: async () => [path.join(workRoot, 'page-1.jpg')],
        vlm: async () => JSON.stringify({
          passed: false,
          issues: [{ kind: 'overflow', description: '标题被截断', severity: 'high' }],
        }),
      },
    });

    expect(result.action).toBe('repair');
    if (result.action === 'repair') {
      expect(result.prompt).toContain('<artifact-render-review>');
      expect(result.prompt).toContain('第 1 页');
      expect(result.prompt).toContain('标题被截断');
    }
  });

  it('修满 3 轮仍失败 → pass 但正文列出页码问题并询问方向', async () => {
    mkdirSync(workRoot, { recursive: true });
    const filePath = path.join(workRoot, 'overflow.docx');
    await writeOverflowDocx(filePath);
    writeFileSync(path.join(workRoot, 'page-1.jpg'), 'img');

    const result = await runArtifactRenderReviewGate({
      workingDirectory: workRoot,
      messages: [message(), producingActivity(filePath)],
      finalText: '已生成 `overflow.docx`。',
      repairsUsed: ARTIFACT_RENDER_REVIEW.MAX_REPAIR_ROUNDS,
      deps: {
        libreOfficeAvailable: () => true,
        rasterize: async () => [path.join(workRoot, 'page-1.jpg')],
        vlm: async () => JSON.stringify({
          passed: false,
          issues: [{ kind: 'overflow', description: '表格右侧被裁切', severity: 'high' }],
        }),
      },
    });

    expect(result.action).toBe('pass');
    if (result.action !== 'pass') throw new Error('expected pass');
    expect(result.content).toContain('视觉审查未通过');
    expect(result.content).toContain('第 1 页');
    expect(result.content).toContain('表格右侧被裁切');
    expect(result.content).toContain('请告诉我方向');
    expect(result.stamp.status).toBe('failed');
  });
});
