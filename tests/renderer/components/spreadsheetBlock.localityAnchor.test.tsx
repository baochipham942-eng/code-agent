// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// SpreadsheetBlock 的锚点接线测试：真点单元格 → 真发出的消息里坐标对不对。
//
// 上游 tests/unit/shared/sheetLocalityRoundtrip.test.ts 守的是「锚点坐标 → 源文件」这一段；
// 这里守的是「用户点了哪 → 锚点坐标」这一段。两段必须分别有测试：组件手里有 sheet.name
// 却忘了传，正是多 sheet 工作簿改错表的成因，而只测下游完全照不出来。

const sendPrompt = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (s: { sendPrompt: typeof sendPrompt }) => unknown) =>
    selector({ sendPrompt }),
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: { generativeUI: { clickToSelect: '点击选择' } } }),
}));

import { SpreadsheetBlock } from '../../../src/renderer/components/features/chat/MessageBubble/SpreadsheetBlock';

// xlsx 实际布局：第 1 行表头 / 第 2 行一月 / 第 3 行空 / 第 4 行三月。
// 空行必须留在 rows 里——它是行号对齐的一部分，也是这个测试的靶子。
const monthlyRows = [['一月', 100], [], ['三月', 300]];

const spec = JSON.stringify({
  sheets: [
    { name: 'Sheet1', headers: ['月份', '销售额'], rows: monthlyRows, rowCount: 3 },
    { name: 'Summary', headers: ['月份', '销售额'], rows: monthlyRows, rowCount: 3 },
  ],
  sheetCount: 2,
});

const b3StartSpec = JSON.stringify({
  sheets: [
    {
      name: 'Sheet1',
      headers: ['月份', '销售额'],
      rows: [['一月', 100], ['三月', 300]],
      rowCount: 2,
      rangeStart: { row: 2, column: 1 },
    },
  ],
  sheetCount: 1,
});

/** 点选某张表里「三月」那行的销售额单元格，输入反馈并回车发送 */
function clickMarchSalesAndSend(sheetName?: string): string {
  if (sheetName) fireEvent.click(screen.getByText(sheetName));
  // 用 title 里的 A1 引用定位「三月」那行的销售额格：三月是第 4 行 → B4
  const cell = document.querySelector('td[title^="B4 ·"]');
  expect(cell).not.toBeNull(); // 正向断言：预览里确实存在 B4 这个可点单元格
  fireEvent.click(cell as Element);

  const input = screen.getByPlaceholderText('这里改成…（回车发送）');
  fireEvent.change(input, { target: { value: '改成 999' } });
  fireEvent.keyDown(input, { key: 'Enter' });

  expect(sendPrompt).toHaveBeenCalledTimes(1);
  return sendPrompt.mock.calls[0][0] as string;
}

beforeEach(() => sendPrompt.mockClear());
afterEach(() => cleanup());

describe('SpreadsheetBlock 点选单元格 → 锚点消息坐标', () => {
  it('used range 从 B3 开始时，点 dataRow1/col0 发出的坐标是 B5', () => {
    render(<SpreadsheetBlock spec={b3StartSpec} filePath="/tmp/b3-start.xlsx" />);

    const cell = document.querySelector('td[title^="B5 · 三月"]');
    expect(cell).not.toBeNull();
    fireEvent.click(cell as Element);
    const input = screen.getByPlaceholderText('这里改成…（回车发送）');
    fireEvent.change(input, { target: { value: '改成四月' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt.mock.calls[0][0]).toContain('B5');
  });

  it('点「三月」那行发出的坐标是 B4，不是被空行左移后的 B3', () => {
    render(<SpreadsheetBlock spec={spec} filePath="/tmp/sales.xlsx" />);
    const prompt = clickMarchSalesAndSend();

    expect(prompt).toContain('B4');
    expect(prompt).toContain('/tmp/sales.xlsx');
  });

  it('切到第 2 张表再点，锚点必须带上「Summary」而不是默认落回第一张表', () => {
    render(<SpreadsheetBlock spec={spec} filePath="/tmp/sales.xlsx" />);
    const prompt = clickMarchSalesAndSend('Summary');

    // 缺了表名，DocEdit 的 getWorksheet 会静默取 worksheets[0] —— 改的是 Sheet1
    expect(prompt).toContain('Summary');
    expect(prompt).toContain('B4');
  });
});
