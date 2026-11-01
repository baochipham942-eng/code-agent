// @vitest-environment jsdom
// csv → sheetsJson 的接线测试：processFile 读文本后必须带上 buildCsvSheetsJson 的
// 产物（消息气泡的交互表格靠它渲染）。getFileCategory 用真实现，保证类别判定
// （.csv → data）不漂移。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const showToast = vi.hoisted(() => vi.fn());
const ipc = vi.hoisted(() => ({
  getPathForFile: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { show: (...args: unknown[]) => showToast(...args) },
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: ipc,
}));
vi.mock('../../../src/renderer/components/features/chat/ChatInput/attachmentSummaries', () => ({
  buildArchiveManifest: vi.fn(),
  buildPresentationSummary: vi.fn(),
}));
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

import { useFileUpload } from '../../../src/renderer/components/features/chat/ChatInput/useFileUpload';

async function processFile(file: File) {
  const { result } = renderHook(() => useFileUpload());
  let attachment: Awaited<ReturnType<typeof result.current.processFile>>;
  await act(async () => {
    attachment = await result.current.processFile(file);
  });
  return attachment!;
}

describe('useFileUpload csv → sheetsJson 接线', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipc.getPathForFile.mockImplementation(async (file: File) => `/tmp/uploads/${file.name}`);
  });

  it('.csv 附件带上 sheetsJson 且 category 保持 data（模型侧 converter 不变）', async () => {
    const attachment = await processFile(
      new File(['月份,销售额\n一月,1000\n二月,2000'], 'sales.csv', { type: 'text/csv' }),
    );

    expect(attachment).not.toBeNull();
    expect(attachment!.category).toBe('data');
    expect(attachment!.path).toBe('/tmp/uploads/sales.csv');
    const spec = JSON.parse(attachment!.sheetsJson!);
    expect(spec.sheets[0].headers).toEqual(['月份', '销售额']);
    expect(spec.sheets[0].rows).toEqual([['一月', 1000], ['二月', 2000]]);
    expect(spec.sheets[0].rowCount).toBe(2);
    expect(spec.sheetCount).toBe(1);
    // data 仍是全文文本：模型侧 processDataAttachment 的输入不变
    expect(attachment!.data).toBe('月份,销售额\n一月,1000\n二月,2000');
  });

  it('.json 附件不产 sheetsJson', async () => {
    const attachment = await processFile(new File(['{"a":1}'], 'data.json', { type: 'application/json' }));
    expect(attachment!.category).toBe('data');
    expect(attachment!.sheetsJson).toBeUndefined();
  });

  it('解析失败的 csv（空文件）静默回退：附件仍产出，无 sheetsJson', async () => {
    const attachment = await processFile(new File([''], 'empty.csv', { type: 'text/csv' }));
    expect(attachment).not.toBeNull();
    expect(attachment!.sheetsJson).toBeUndefined();
  });
});
