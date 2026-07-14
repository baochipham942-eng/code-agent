import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AttachmentDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview';
import type { MessageAttachment } from '../../../src/shared/contract/message';

// rowCount 是 isSheetData 的必填校验项，缺了会让 parseSpec 返回 null、组件整个不渲染。
const sheetsJson = JSON.stringify({
  sheets: [{ name: 'Sheet1', headers: ['月份', '销售额'], rows: [['一月', 1000]], rowCount: 1 }],
});

function excelAttachment(path?: string): MessageAttachment {
  return {
    id: 'a1',
    type: 'file',
    category: 'excel',
    name: 'sales.xlsx',
    size: 1024,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sheetsJson,
    ...(path ? { path } : {}),
  };
}

// 定点反馈栏只在单元格可点选时才有意义，而单元格可点选的开关是 filePath。
// 这里用「点选定点反馈」这个 title 文案当探针，判断 filePath 有没有传到 SpreadsheetBlock。
const LOCALITY_PROBE = '点选定点反馈';

describe('AttachmentDisplay → SpreadsheetBlock filePath 贯通', () => {
  it('本地绝对路径的 Excel 附件启用单元格定点反馈', () => {
    const html = renderToStaticMarkup(
      <AttachmentDisplay attachments={[excelAttachment('/tmp/sales.xlsx')]} />,
    );
    expect(html).toContain(LOCALITY_PROBE);
  });

  it('渠道附件的 http URL 不当作可编辑源文件', () => {
    // channelAgentBridge.pathFromAttachmentUrl 会把 http(s) URL 原样塞进 path。
    // 若不加护栏，会让模型去 DocEdit 一个不存在的本地文件。
    const html = renderToStaticMarkup(
      <AttachmentDisplay attachments={[excelAttachment('https://example.com/sales.xlsx')]} />,
    );
    expect(html).not.toContain(LOCALITY_PROBE);
  });

  it('没有 path 的 Excel 附件退化为只读表格', () => {
    const html = renderToStaticMarkup(<AttachmentDisplay attachments={[excelAttachment()]} />);
    expect(html).not.toContain(LOCALITY_PROBE);
    expect(html).toContain('销售额'); // 表格本身仍然渲染
  });
});
