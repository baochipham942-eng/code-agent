import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AttachmentDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview';
import type { MessageAttachment } from '../../../src/shared/contract/message';

// renderer 侧 buildCsvSheetsJson 产出的形状（useFileUpload 的 csv 分支）。
const csvSheetsJson = JSON.stringify({
  sheets: [{ name: 'sales', headers: ['月份', '销售额'], rows: [['一月', 1000]], rowCount: 1 }],
  sheetCount: 1,
});

function csvAttachment(): MessageAttachment {
  return {
    id: 'a1',
    type: 'file',
    category: 'data',
    name: 'sales.csv',
    size: 64,
    mimeType: 'text/csv',
    language: 'csv',
    sheetsJson: csvSheetsJson,
    path: '/tmp/code-agent-uploads/uuid/sales.csv',
  };
}

function jsonDataAttachment(): MessageAttachment {
  return {
    id: 'a2',
    type: 'file',
    category: 'data',
    name: 'data.json',
    size: 64,
    mimeType: 'application/json',
    language: 'json',
    data: '{"a":1}',
  };
}

describe('AttachmentDisplay → csv 附件的交互表格', () => {
  it('category=data 的 .csv 附件挂 SpreadsheetBlock（表头 + 数据行渲染成表格）', () => {
    const html = renderToStaticMarkup(<AttachmentDisplay attachments={[csvAttachment()]} />);
    expect(html).toContain('<table');
    expect(html).toContain('月份');
    expect(html).toContain('一月');
    // csv 没有 xlsx 工作表坐标系，不启用 DocEdit 定点反馈
    expect(html).not.toContain('点选定点反馈');
  });

  it('同为 data 类别的 .json 附件仍是普通图标卡，不渲染表格', () => {
    const html = renderToStaticMarkup(<AttachmentDisplay attachments={[jsonDataAttachment()]} />);
    expect(html).not.toContain('<table');
    expect(html).toContain('data.json');
  });

  it('没有 sheetsJson 的 .csv 附件（解析失败回退）仍是普通图标卡', () => {
    const { sheetsJson, ...rest } = csvAttachment();
    expect(sheetsJson).toBeDefined();
    const html = renderToStaticMarkup(<AttachmentDisplay attachments={[rest]} />);
    expect(html).not.toContain('<table');
    expect(html).toContain('sales.csv');
  });
});
