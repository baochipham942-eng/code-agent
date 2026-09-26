// ============================================================================
// artifactRenderReview — docx/pdf/xlsx 渲染审查闸
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';

const execFileMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());
const execMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => execFileMock(...args),
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
    execSync: (...args: unknown[]) => {
      execSyncMock(...args);
      return (actual.execSync as (...inner: unknown[]) => unknown)(...args);
    },
    exec: (...args: unknown[]) => {
      execMock(...args);
      return (actual.exec as (...inner: unknown[]) => unknown)(...args);
    },
    spawn: (...args: unknown[]) => {
      spawnMock(...args);
      return (actual.spawn as (...inner: unknown[]) => unknown)(...args);
    },
    spawnSync: (...args: unknown[]) => {
      spawnSyncMock(...args);
      return (actual.spawnSync as (...inner: unknown[]) => unknown)(...args);
    },
  };
});

import {
  applyDeliverableCloseGates,
  checkXlsxStructure,
  reviewRenderableDeliverables,
  runArtifactRenderReviewGate,
} from '../../../../src/host/agent/runtime/artifactRenderReview';
import { rasterizePdfToImages } from '../../../../src/host/tools/media/officeRaster';
import { ARTIFACT_RENDER_REVIEW, TURN_OUTCOME } from '../../../../src/shared/constants/agent';
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

  it('VLM 返回非 JSON 时不置通过，status 为 skipped_no_vlm', async () => {
    mkdirSync(workRoot, { recursive: true });
    const filePath = path.join(workRoot, 'clean.docx');
    await writeCleanDocx(filePath);
    writeFileSync(path.join(workRoot, 'page-1.jpg'), 'fake-image');

    const stamp = await reviewRenderableDeliverables([filePath], {
      libreOfficeAvailable: () => true,
      rasterize: async () => [path.join(workRoot, 'page-1.jpg')],
      vlm: async () => '版面看起来还行，没有明显问题。',
    });

    expect(stamp.status).toBe('skipped_no_vlm');
    expect(stamp.issues).toEqual([]);
  });

  it('全部页面都解析失败时标 skipped_no_vlm，不盖 passed', async () => {
    mkdirSync(workRoot, { recursive: true });
    const filePath = path.join(workRoot, 'clean.pdf');
    writeFileSync(filePath, '%PDF-1.4');
    writeFileSync(path.join(workRoot, 'page-1.jpg'), 'img');
    writeFileSync(path.join(workRoot, 'page-2.jpg'), 'img');

    const stamp = await reviewRenderableDeliverables([filePath], {
      libreOfficeAvailable: () => true,
      rasterize: async () => [path.join(workRoot, 'page-1.jpg'), path.join(workRoot, 'page-2.jpg')],
      vlm: async () => 'not-json {passed: true}',
    });

    expect(stamp.status).toBe('skipped_no_vlm');
  });

  it('不存在或非普通文件的路径跳过，不调用 rasterize', async () => {
    mkdirSync(workRoot, { recursive: true });
    const missing = path.join(workRoot, 'no-such.pdf');
    const dirPath = path.join(workRoot, 'a-directory.pdf');
    mkdirSync(dirPath);
    let rasterizeCalls = 0;

    const stamp = await reviewRenderableDeliverables([missing, dirPath], {
      libreOfficeAvailable: () => true,
      rasterize: async () => {
        rasterizeCalls += 1;
        throw new Error('must not rasterize missing or non-file paths');
      },
      vlm: async () => {
        throw new Error('VLM must not run');
      },
    });

    expect(rasterizeCalls).toBe(0);
    expect(stamp.status).toBe('not_applicable');
    expect(stamp.filesReviewed).toEqual([]);
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

describe('close-gate shell injection', () => {
  const pwnedPaths: string[] = [];

  function failExecFile(file: string, args?: unknown, options?: unknown, callback?: unknown) {
    const cb = typeof args === 'function' ? args
      : typeof options === 'function' ? options
      : typeof callback === 'function' ? callback
      : undefined;
    const err = Object.assign(new Error(`mocked execFile: ${file}`), { code: 'ENOENT' });
    if (typeof cb === 'function') {
      process.nextTick(() => (cb as (error: Error) => void)(err));
      return;
    }
    throw err;
  }

  beforeEach(() => {
    execFileMock.mockReset();
    execFileSyncMock.mockReset();
    execSyncMock.mockReset();
    execMock.mockReset();
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    execFileMock.mockImplementation(failExecFile);
    execFileSyncMock.mockImplementation(() => {
      throw new Error('mocked execFileSync');
    });
  });

  afterEach(() => {
    for (const pwned of pwnedPaths.splice(0)) {
      if (existsSync(pwned)) rmSync(pwned, { force: true });
    }
  });

  function claimPayload() {
    mkdirSync(workRoot, { recursive: true });
    const id = randomUUID().slice(0, 8);
    const pwnedPath = `/tmp/pwned-${id}`;
    pwnedPaths.push(pwnedPath);
    const evilName = `r$(touch ${pwnedPath}).pdf`;
    const evilPath = `${workRoot}/${evilName}`;
    return { pwnedPath, evilName, evilPath };
  }

  it('missing $(touch) claim after disk budget is exhausted never spawns a process', async () => {
    const { pwnedPath, evilName, evilPath } = claimPayload();

    const result = await applyDeliverableCloseGates({
      workingDirectory: workRoot,
      messages: [message(), producingActivity(evilPath)],
      finalText: `已生成 \`${evilName}\`。`,
      diskRepairsUsed: TURN_OUTCOME.MAX_DELIVERABLE_REPAIR_ROUNDS,
      visualRepairsUsed: 0,
      deps: {
        vlm: async () => {
          throw new Error('VLM must not run for a missing file');
        },
      },
    });

    expect(result.action).toBe('pass');
    expect(existsSync(pwnedPath)).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('rasterizePdfToImages passes $(touch) path as an execFile argument, not a shell string', async () => {
    const { pwnedPath, evilPath } = claimPayload();
    const outDir = path.join(workRoot, 'out');
    mkdirSync(outDir, { recursive: true });

    await expect(rasterizePdfToImages(evilPath, outDir, 'deck')).rejects.toThrow(/Screenshot rendering failed/);

    expect(existsSync(pwnedPath)).toBe(false);
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    const conversionCalls = execFileMock.mock.calls.filter((call) => {
      const args = call[1];
      return Array.isArray(args) && args.some((arg) => String(arg).includes('$(touch'));
    });
    expect(conversionCalls.length).toBeGreaterThan(0);
    expect(conversionCalls.some((call) => Array.isArray(call[1]) && call[1].includes(evilPath))).toBe(true);
  });
});
