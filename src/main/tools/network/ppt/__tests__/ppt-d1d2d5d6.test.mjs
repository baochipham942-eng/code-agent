// ============================================================================
// PPT D1/D2/D5/D6 测试 — 模板引擎 + 数据驱动 + 人机协作 + 排版
// 运行: npx tsx src/main/tools/network/ppt/__tests__/ppt-d1d2d5d6.test.mjs
// ============================================================================

import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const projectRequire = createRequire(
  path.resolve('/Users/linchen/Downloads/ai/code-agent/package.json')
);
globalThis.require = projectRequire;

const WD = '/Users/linchen/Downloads/ai/code-agent';
let pass = 0, fail = 0;

function log(name, ok, detail = '') {
  const icon = ok ? '✅' : '❌';
  console.log(`  ${icon} ${name}${detail ? ' — ' + detail : ''}`);
  if (ok) pass++; else { fail++; process.exitCode = 1; }
}

// ============================================================================
// Part A: Typography (D6) — 排版工具
// ============================================================================
console.log('\n═══ Part A: Typography (D6) ═══');

const { detectCJKRatio, isCJKDominant, selectFont, normalizeCJKSpacing, calculateFitFontSize } = await import('../typography.ts');

// A.1 detectCJKRatio: pure Chinese text → ratio > 0.9
{
  const ratio = detectCJKRatio('你好世界');
  log('A.1 detectCJKRatio 纯中文 > 0.9', ratio > 0.9, `ratio=${ratio.toFixed(3)}`);
}

// A.2 detectCJKRatio: pure English text → ratio = 0
{
  const ratio = detectCJKRatio('Hello World');
  log('A.2 detectCJKRatio 纯英文 = 0', ratio === 0, `ratio=${ratio}`);
}

// A.3 detectCJKRatio: mixed text → ratio between 0.2 and 0.8
{
  const ratio = detectCJKRatio('你好World');
  log('A.3 detectCJKRatio 混合文本 0.2~0.8', ratio > 0.2 && ratio < 0.8, `ratio=${ratio.toFixed(3)}`);
}

// A.4 detectCJKRatio: empty string → 0
{
  const ratio = detectCJKRatio('');
  log('A.4 detectCJKRatio 空字符串 = 0', ratio === 0, `ratio=${ratio}`);
}

// A.5 isCJKDominant: pure Chinese → true
{
  const result = isCJKDominant('你好世界测试');
  log('A.5 isCJKDominant 纯中文 = true', result === true);
}

// A.6 isCJKDominant: pure English → false
{
  const result = isCJKDominant('Hello World Test');
  log('A.6 isCJKDominant 纯英文 = false', result === false);
}

// A.7 isCJKDominant: mixed '中文占比30%以下abc'
{
  // '中文占比30%以下abc' has 8 CJK chars (中文占比 以下) out of total 14 chars
  // Actually: 中文占比30%以下abc → CJK: 中文占比以下 = 6, total chars = 12 (中文占比30%以下abc)
  // Let's compute: '中文占比30%以下abc'
  // 中(CJK) 文(CJK) 占(CJK) 比(CJK) 3 0 % 以(CJK) 下(CJK) a b c = 12 chars, 6 CJK
  // ratio = 6/12 = 0.5 > 0.3 → true
  const text = '中文占比30%以下abc';
  const ratio = detectCJKRatio(text);
  const result = isCJKDominant(text);
  log('A.7 isCJKDominant 混合文本', result === true, `ratio=${ratio.toFixed(3)}, dominant=${result}`);
}

// A.8 selectFont: CJK text, isTitle=true, with titleFontCN → returns titleFontCN
{
  const font = selectFont('你好世界', 'Arial', 'Calibri', 'PingFang SC', 'Microsoft YaHei', true);
  log('A.8 selectFont CJK+title → titleFontCN', font === 'PingFang SC', `font=${font}`);
}

// A.9 selectFont: English text, isTitle=true → returns titleFont (not CN)
{
  const font = selectFont('Hello World', 'Arial', 'Calibri', 'PingFang SC', 'Microsoft YaHei', true);
  log('A.9 selectFont English+title → titleFont', font === 'Arial', `font=${font}`);
}

// A.10 selectFont: CJK text, isTitle=false, with bodyFontCN → returns bodyFontCN
{
  const font = selectFont('你好世界', 'Arial', 'Calibri', 'PingFang SC', 'Microsoft YaHei', false);
  log('A.10 selectFont CJK+body → bodyFontCN', font === 'Microsoft YaHei', `font=${font}`);
}

// A.11 selectFont: CJK text, no CN font provided → returns Latin font fallback
{
  const font = selectFont('你好世界', 'Arial', 'Calibri', undefined, undefined, true);
  log('A.11 selectFont CJK 无 CN 字体 → Latin 回退', font === 'Arial', `font=${font}`);
}

// A.12 normalizeCJKSpacing: '中文text' → '中文 text'
{
  const result = normalizeCJKSpacing('中文text');
  log('A.12 normalizeCJKSpacing 中→英', result === '中文 text', `"${result}"`);
}

// A.13 normalizeCJKSpacing: 'abc中文' → 'abc 中文'
{
  const result = normalizeCJKSpacing('abc中文');
  log('A.13 normalizeCJKSpacing 英→中', result === 'abc 中文', `"${result}"`);
}

// A.14 normalizeCJKSpacing: '中文 text' → unchanged (already has space)
{
  const result = normalizeCJKSpacing('中文 text');
  log('A.14 normalizeCJKSpacing 已有空格不变', result === '中文 text', `"${result}"`);
}

// A.15 calculateFitFontSize: short text in large box → returns baseFontSize unchanged
{
  const fontSize = calculateFitFontSize('Hi', 10, 5, 24, 10);
  log('A.15 calculateFitFontSize 短文本大框 = baseFontSize', fontSize === 24, `fontSize=${fontSize}`);
}

// A.16 calculateFitFontSize: very long text in small box → returns minFontSize
{
  const longText = '这是一段非常非常非常非常长的文字，'.repeat(20);
  const fontSize = calculateFitFontSize(longText, 2, 0.5, 24, 10);
  log('A.16 calculateFitFontSize 长文本小框 = minFontSize', fontSize === 10, `fontSize=${fontSize}`);
}

// A.17 calculateFitFontSize: empty text → returns baseFontSize
{
  const fontSize = calculateFitFontSize('', 10, 5, 24, 10);
  log('A.17 calculateFitFontSize 空文本 = baseFontSize', fontSize === 24, `fontSize=${fontSize}`);
}

// ============================================================================
// Part B: Preview (D5) — 预览摘要
// ============================================================================
console.log('\n═══ Part B: Preview (D5) ═══');

const { generateSlidePreview } = await import('../preview.ts');

{
  const slides = [
    { title: '演示标题', subtitle: '副标题', points: [], isTitle: true },
    { title: '内容页', points: ['要点一', '要点二', '要点三'] },
    { title: '谢谢', points: [], isEnd: true },
  ];

  const preview = generateSlidePreview(slides);

  // B.1 Contains "# PPT 预览摘要"
  log('B.1 预览包含标题', preview.includes('# PPT 预览摘要'));

  // B.2 Title slide tagged with "[封面]"
  log('B.2 封面页标记 [封面]', preview.includes('[封面]'));

  // B.3 End slide tagged with "[结束]"
  log('B.3 结束页标记 [结束]', preview.includes('[结束]'));

  // B.4 Points are listed as markdown bullet points ("- ")
  log('B.4 要点用 "- " 列出', preview.includes('- 要点一') && preview.includes('- 要点二'));

  // B.5 Slide count line: "共 X 张幻灯片" matches slides.length
  log('B.5 幻灯片数量行', preview.includes(`共 ${slides.length} 张幻灯片`), `共 ${slides.length} 张`);
}

// ============================================================================
// Part C: Data Analyzer (D2) — 数据分析器
// ============================================================================
console.log('\n═══ Part C: Data Analyzer (D2) ═══');

const { analyzeDataForPresentation, suggestChartType, generateChartData } = await import('../dataAnalyzer.ts');

const mockData = {
  columns: ['Name', 'Revenue', 'Growth'],
  rows: [
    ['Product A', '1000', '15'],
    ['Product B', '2000', '25'],
    ['Product C', '1500', '20'],
    ['Product D', '3000', '30'],
    ['Product E', '500', '10'],
  ],
  metadata: {
    fileName: 'test.xlsx',
    sheetName: 'Sheet1',
    rowCount: 5,
    columnCount: 3,
  },
  insights: [
    {
      type: 'summary',
      title: '数据概览',
      description: '5 行 × 3 列',
    },
    {
      type: 'top_values',
      title: 'Revenue Top 5',
      description: '按 Revenue 排序',
      data: {
        labels: ['Product D', 'Product B', 'Product C', 'Product A', 'Product E'],
        values: [3000, 2000, 1500, 1000, 500],
      },
    },
    {
      type: 'distribution',
      title: 'Revenue 分布',
      description: '均值: 1600, 范围: 500 ~ 3000',
      data: {
        labels: ['最小值', '均值', '最大值'],
        values: [500, 1600, 3000],
      },
    },
  ],
};

// C.1 analyzeDataForPresentation: returns slides array with title + end
{
  const slides = analyzeDataForPresentation(mockData, '测试报告');
  const hasTitle = slides.some(s => s.isTitle === true);
  const hasEnd = slides.some(s => s.isEnd === true);
  log('C.1 analyzeData 返回含 title + end', hasTitle && hasEnd, `${slides.length} slides`);
}

// C.2 First slide is title slide (isTitle: true)
{
  const slides = analyzeDataForPresentation(mockData, '测试报告');
  log('C.2 首页 isTitle', slides[0].isTitle === true);
}

// C.3 Last slide is end slide (isEnd: true)
{
  const slides = analyzeDataForPresentation(mockData, '测试报告');
  log('C.3 末页 isEnd', slides[slides.length - 1].isEnd === true);
}

// C.4 Data overview slide exists with row/column counts
{
  const slides = analyzeDataForPresentation(mockData, '测试报告');
  const overviewSlide = slides.find(s => s.title === '数据概览');
  const hasRowInfo = overviewSlide?.points.some(p => p.includes('5') && p.includes('记录'));
  const hasColInfo = overviewSlide?.points.some(p => p.includes('3') && p.includes('字段'));
  log('C.4 数据概览 slide 含行列信息', !!overviewSlide && !!hasRowInfo && !!hasColInfo,
    overviewSlide ? overviewSlide.points[1] : 'not found');
}

// C.5 suggestChartType: trend insight → 'line'
{
  const insight = { type: 'trend', title: '趋势', description: '...' };
  const chartType = suggestChartType(insight, 5);
  log('C.5 suggestChartType trend → line', chartType === 'line', chartType);
}

// C.6 suggestChartType: distribution with ≤6 rows → 'doughnut'
{
  const insight = { type: 'distribution', title: '分布', description: '...' };
  const chartType = suggestChartType(insight, 5);
  log('C.6 suggestChartType distribution ≤6 → doughnut', chartType === 'doughnut', chartType);
}

// C.7 suggestChartType: distribution with >6 rows → 'bar'
{
  const insight = { type: 'distribution', title: '分布', description: '...' };
  const chartType = suggestChartType(insight, 10);
  log('C.7 suggestChartType distribution >6 → bar', chartType === 'bar', chartType);
}

// C.8 suggestChartType: top_values → 'bar'
{
  const insight = { type: 'top_values', title: 'Top', description: '...' };
  const chartType = suggestChartType(insight, 5);
  log('C.8 suggestChartType top_values → bar', chartType === 'bar', chartType);
}

// C.9 generateChartData: valid data → returns labels and values
{
  const chartData = generateChartData(mockData, 0, 1);
  const valid = chartData !== null && Array.isArray(chartData.labels) && Array.isArray(chartData.values);
  log('C.9 generateChartData 有效数据', valid,
    chartData ? `${chartData.labels.length} labels, ${chartData.values.length} values` : 'null');
}

// C.10 generateChartData: column index out of range → returns null
{
  const chartData = generateChartData(mockData, 0, 99);
  log('C.10 generateChartData 列越界 → null', chartData === null);
}

// ============================================================================
// Part D: Data Source Adapter (D2) — 数据源适配器
// ============================================================================
console.log('\n═══ Part D: Data Source Adapter (D2) ═══');

const { loadDataSource } = await import('../dataSourceAdapter.ts');

// D.1 loadDataSource with nonexistent file → throws error
{
  let threw = false;
  try {
    await loadDataSource('/nonexistent/path/data.csv');
  } catch (e) {
    threw = true;
  }
  log('D.1 loadDataSource 不存在文件 → 抛错', threw);
}

// D.2 loadDataSource with unsupported extension → throws error
{
  // Create a temp .txt file to test unsupported extension
  const tmpTxt = path.join(os.tmpdir(), `test-ppt-unsupported-${Date.now()}.txt`);
  let threw = false;
  try {
    fs.writeFileSync(tmpTxt, 'some data');
    await loadDataSource(tmpTxt);
  } catch (e) {
    threw = true;
  } finally {
    try { fs.unlinkSync(tmpTxt); } catch {}
  }
  log('D.2 loadDataSource 不支持格式 → 抛错', threw);
}

// D.3 - D.5: CSV loading tests
{
  const tmpCsv = path.join(os.tmpdir(), `test-ppt-${Date.now()}.csv`);
  try {
    fs.writeFileSync(tmpCsv, 'Name,Score,Grade\nAlice,95,A\nBob,80,B\nCharlie,70,C\nDave,60,D\nEve,90,A\n');

    const result = await loadDataSource(tmpCsv);

    // D.3 CSV loading: verify columns and rows
    const columnsOk = result.columns.length === 3 &&
      result.columns[0] === 'Name' && result.columns[1] === 'Score' && result.columns[2] === 'Grade';
    const rowsOk = result.rows.length === 5;
    log('D.3 CSV 加载: columns + rows', columnsOk && rowsOk,
      `cols=${result.columns.join(',')}, rows=${result.rows.length}`);

    // D.4 CSV loading: verify insights array is not empty (at least summary)
    const hasSummary = result.insights.some(i => i.type === 'summary');
    log('D.4 CSV 加载: insights 非空 + 含 summary', result.insights.length > 0 && hasSummary,
      `${result.insights.length} insights`);

    // D.5 CSV loading: verify metadata has correct fileName and rowCount
    const metaOk = result.metadata.fileName === path.basename(tmpCsv) && result.metadata.rowCount === 5;
    log('D.5 CSV 加载: metadata 正确', metaOk,
      `fileName=${result.metadata.fileName}, rowCount=${result.metadata.rowCount}`);
  } catch (e) {
    log('D.3 CSV 加载: columns + rows', false, `Error: ${e.message}`);
    log('D.4 CSV 加载: insights 非空 + 含 summary', false, 'skipped');
    log('D.5 CSV 加载: metadata 正确', false, 'skipped');
  } finally {
    try { fs.unlinkSync(tmpCsv); } catch {}
  }
}

// ============================================================================
// Part E: SCQA Outline (D3) — 结构化大纲
// ============================================================================
console.log('\n═══ Part E: SCQA Outline (D3) ═══');

const { outlineToSlideData } = await import('../parser.ts');

// E.1 outlineToSlideData: returns title slide as first
{
  const slides = outlineToSlideData('测试主题', 8);
  log('E.1 SCQA 首页 isTitle', slides[0].isTitle === true);
}

// E.2 outlineToSlideData: returns end slide as last
{
  const slides = outlineToSlideData('测试主题', 8);
  log('E.2 SCQA 末页 isEnd', slides[slides.length - 1].isEnd === true);
}

// E.3 outlineToSlideData: count parameter limits total slides
{
  const slides4 = outlineToSlideData('测试主题', 4);
  const slides8 = outlineToSlideData('测试主题', 8);
  // count=4 → title + 2 sections + end = 4
  // count=8 → title + 6 sections + end = 8
  log('E.3 SCQA count 限制 slides 数量', slides4.length <= 4 && slides8.length <= 8,
    `count=4→${slides4.length}, count=8→${slides8.length}`);
}

// E.4 outlineToSlideData: content slides have 4 points each
{
  const slides = outlineToSlideData('测试主题', 8);
  // Skip title (index 0) and end (last)
  const contentSlides = slides.slice(1, -1);
  const allHave4Points = contentSlides.every(s => s.points.length === 4);
  log('E.4 SCQA 内容页各 4 个要点', allHave4Points,
    contentSlides.map(s => s.points.length).join(','));
}

// E.5 outlineToSlideData: includes "背景概述" in slide titles (SCQA structure)
{
  const slides = outlineToSlideData('测试主题', 8);
  const hasBgSlide = slides.some(s => s.title === '背景概述');
  log('E.5 SCQA 含"背景概述"', hasBgSlide,
    slides.map(s => s.title).join(' | '));
}

// ============================================================================
// Part F: Edit Tool (D5) — 编辑工具
// ============================================================================
console.log('\n═══ Part F: Edit Tool (D5) ═══');

const { pptEditTool } = await import('../editTool.ts');

// F.1 pptEditTool.name is 'ppt_edit'
{
  log('F.1 pptEditTool.name = ppt_edit', pptEditTool.name === 'ppt_edit', pptEditTool.name);
}

// F.2 inputSchema has required fields ['file_path', 'action']
{
  const required = pptEditTool.inputSchema.required;
  const hasFilePath = required.includes('file_path');
  const hasAction = required.includes('action');
  log('F.2 inputSchema required = [file_path, action]', hasFilePath && hasAction,
    JSON.stringify(required));
}

// F.3 inputSchema action enum has 6 values
{
  const actionEnum = pptEditTool.inputSchema.properties.action.enum;
  log('F.3 action enum 有 6 个值', actionEnum.length === 6,
    `${actionEnum.length}: ${actionEnum.join(', ')}`);
}

// F.4 execute with nonexistent file → returns { success: false }
{
  try {
    const r = await pptEditTool.execute(
      { file_path: '/nonexistent/test.pptx', action: 'extract_style' },
      { workingDirectory: WD },
    );
    log('F.4 不存在文件 → success=false', r.success === false, r.error || '');
  } catch (e) {
    log('F.4 不存在文件 → success=false', false, `threw: ${e.message}`);
  }
}

// F.5 extract_style action: execute with a valid generated pptx → returns style info
{
  const tmpPptx = path.join(os.tmpdir(), `edit-test-${Date.now()}.pptx`);
  let generatedOk = false;
  try {
    const { pptGenerateTool } = await import('../index.ts');
    const genResult = await pptGenerateTool.execute({
      topic: 'Edit Test',
      slides_count: 3,
      theme: 'apple-dark',
      output_path: tmpPptx,
    }, { workingDirectory: WD });
    generatedOk = genResult.success;

    if (generatedOk) {
      const r = await pptEditTool.execute(
        { file_path: tmpPptx, action: 'extract_style' },
        { workingDirectory: WD },
      );
      const hasStyle = r.success && r.metadata?.styleConfig != null;
      log('F.5 extract_style 提取样式', hasStyle,
        hasStyle ? `accent=#${r.metadata.styleConfig.accent}` : (r.error || 'no metadata'));
    } else {
      log('F.5 extract_style 提取样式', false, '生成 PPTX 失败');
    }
  } catch (e) {
    log('F.5 extract_style 提取样式', false, `Error: ${e.message}`);
  } finally {
    try { fs.unlinkSync(tmpPptx); } catch {}
    // Also clean up any backup files
    try {
      const tmpDir = os.tmpdir();
      const files = fs.readdirSync(tmpDir);
      for (const f of files) {
        if (f.startsWith('edit-test-') && f.includes('.backup-')) {
          try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
        }
      }
    } catch {}
  }
}

// ============================================================================
// Summary
// ============================================================================
console.log(`\n═══ Summary: ${pass} passed, ${fail} failed (${pass + fail} total) ═══`);
if (fail) {
  console.log(`❌ ${fail} 个用例失败`);
} else {
  console.log('✅ 全部通过');
}
