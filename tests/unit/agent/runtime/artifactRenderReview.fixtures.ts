import { writeFileSync } from 'node:fs';
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';

export async function writeOverflowDocx(filePath: string): Promise<void> {
  const wideCells = Array.from({ length: 8 }, (_, index) => new TableCell({
    width: { size: 3000, type: WidthType.DXA },
    children: [new Paragraph({
      children: [new TextRun({
        text: `COL${index + 1}-${'OVERFLOWTEXT'.repeat(12)}`,
        size: 48,
        bold: true,
      })],
    })],
  }));
  const doc = new Document({
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 360, right: 360, bottom: 360, left: 360 },
        },
      },
      children: [
        new Paragraph({ children: [new TextRun({ text: '溢出夹具标题'.repeat(20), size: 72, bold: true })] }),
        new Table({
          width: { size: 24000, type: WidthType.DXA },
          columnWidths: Array.from({ length: 8 }, () => 3000),
          rows: [new TableRow({ children: wideCells })],
        }),
      ],
    }],
  });
  writeFileSync(filePath, await Packer.toBuffer(doc));
}

export async function writeCleanDocx(filePath: string): Promise<void> {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ children: [new TextRun({ text: '季度报告', size: 32, bold: true })] }),
        new Paragraph({ children: [new TextRun({ text: '本页只有两段短句，版面留白充足。', size: 22 })] }),
      ],
    }],
  });
  writeFileSync(filePath, await Packer.toBuffer(doc));
}
