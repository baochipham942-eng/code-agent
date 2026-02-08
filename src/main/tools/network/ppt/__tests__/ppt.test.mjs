// ============================================================================
// PPT 生成系统 — 综合测试用例
// 运行: npx tsx src/main/tools/network/ppt/__tests__/ppt.test.mjs
// ============================================================================

import { createRequire } from 'module';
import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const projectRequire = createRequire(
  path.resolve('/Users/linchen/Downloads/ai/code-agent/package.json')
);
globalThis.require = projectRequire;

const { pptGenerateTool } = await import('../index.ts');
const { parseContentToSlides, generatePlaceholderSlides } = await import('../parser.ts');
const { detectChartData } = await import('../charts.ts');
const { getThemeConfig, isAppleDark } = await import('../themes.ts');

const WD = '/Users/linchen/Downloads/ai/code-agent';
const generatedFiles = [];

function log(name, ok, detail = '') {
  const icon = ok ? '✅' : '❌';
  console.log(`  ${icon} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

async function generate(params) {
  const r = await pptGenerateTool.execute(params, { workingDirectory: WD });
  if (r.success && r.metadata?.filePath) generatedFiles.push(r.metadata.filePath);
  return r;
}

// ============================================================================
// Part 1: 单元测试 — Parser
// ============================================================================
console.log('\n═══ Part 1: Parser 单元测试 ═══');

// 1.1 基础解析
{
  const slides = parseContentToSlides('# 标题\n## 副标题\n# 内容页\n- 要点1\n- 要点2\n# 谢谢', 10);
  log('1.1 基础解析', slides.length === 3, `${slides.length} slides`);
  log('1.1a 首页 isTitle', slides[0].isTitle === true);
  log('1.1b 首页副标题', slides[0].subtitle === '副标题');
  log('1.1c 末页 isEnd', slides[2].isEnd === true);
  log('1.1d 内容要点数', slides[1].points.length === 2);
}

// 1.2 End 检测：多种结尾关键词
{
  const endings = ['谢谢观看', '感谢关注', 'Thank You', 'Q&A 环节', '总结'];
  for (const title of endings) {
    const slides = parseContentToSlides(`# 开头\n# ${title}`, 10);
    const last = slides[slides.length - 1];
    log(`1.2 End 检测: "${title}"`, last.isEnd === true);
  }
}

// 1.3 非 End 标题不误判
{
  const slides = parseContentToSlides('# 开头\n# 未来展望\n- 要点', 10);
  log('1.3 非 End 不误判: "未来展望"', slides[1].isEnd !== true);
}

// 1.4 代码块解析
{
  const slides = parseContentToSlides('# 代码\n```python\nprint("hello")\n```', 10);
  log('1.4 代码块解析', slides[0].code?.language === 'python');
}

// 1.5 占位内容生成
{
  const slides = generatePlaceholderSlides('测试主题', 8);
  log('1.5 占位生成', slides.length === 7, `${slides.length} slides`);
  log('1.5a 首页标题', slides[0].title === '测试主题');
  log('1.5b 末页 isEnd', slides[slides.length - 1].isEnd === true);
}

// 1.6 maxSlides 限制
{
  const content = Array.from({ length: 20 }, (_, i) => `# 页面${i}`).join('\n');
  const slides = parseContentToSlides(content, 5);
  log('1.6 maxSlides 限制', slides.length === 5);
}

// ============================================================================
// Part 2: 单元测试 — Charts 检测
// ============================================================================
console.log('\n═══ Part 2: Charts 检测单元测试 ═══');

// 2.1 标准数据 → 应生成图表
{
  const data = detectChartData('市场数据统计', [
    '北美市场收入 380 亿',
    '欧洲市场收入 270 亿',
    '亚太市场收入 250 亿',
    '其他地区收入 100 亿',
  ]);
  log('2.1 标准数据 → 图表', data !== null);
  log('2.1a 类型=bar', data?.chartType === 'bar');
  log('2.1b labels=4', data?.labels.length === 4);
}

// 2.2 占比数据 → 环形图
{
  const data = detectChartData('市场份额占比', [
    '产品A 占比 45%',
    '产品B 占比 30%',
    '产品C 占比 15%',
    '其他 占比 10%',
  ]);
  log('2.2 占比 → doughnut', data?.chartType === 'doughnut');
}

// 2.3 趋势数据 → 折线图
{
  const data = detectChartData('年度增长趋势', [
    '2023年收入 100 万',
    '2024年收入 150 万',
    '2025年收入 220 万',
  ]);
  log('2.3 趋势 → line', data?.chartType === 'line');
}

// 2.4 标题无数据关键词 → 不生成
{
  const data = detectChartData('核心价值', [
    '代码补全准确率 92%',
    '支持 50+ 语言',
    '检出率提升 80%',
  ]);
  log('2.4 无数据关键词 → null', data === null);
}

// 2.5 数量级不一致 → 不生成（150亿 vs 68）
{
  const data = detectChartData('市场数据', [
    'AI 市场规模 150 亿美元',
    '采用率增长至 68%',
    '满意度 4.7 分',
    '速度提升 320%',
    '年增长率 35%',
  ]);
  log('2.5 数量级不一致 → null', data === null,
    data ? `ratio=${Math.max(...data.values)/Math.min(...data.values)}` : 'rejected');
}

// 2.6 不足 3 个数据点 → 不生成
{
  const data = detectChartData('市场数据', [
    '收入 100 万',
    '增长 20%',
  ]);
  log('2.6 不足 3 点 → null', data === null);
}

// 2.7 描述性数字（非核心数据）→ 不生成
{
  const data = detectChartData('产品功能介绍', [
    '支持超过 50 种编程语言和框架体系',
    '内置 200 个常用代码模板和最佳实践',
    '兼容 30 款主流 IDE 开发工具',
  ]);
  log('2.7 描述性数字 → null', data === null);
}

// ============================================================================
// Part 3: 单元测试 — Themes
// ============================================================================
console.log('\n═══ Part 3: Themes 单元测试 ═══');

// 3.1 所有主题都能获取（name 是中文显示名，验证 config 有效性）
{
  const themes = ['neon-green', 'neon-blue', 'neon-purple', 'neon-orange',
    'glass-light', 'glass-dark', 'minimal-mono', 'corporate', 'apple-dark'];
  for (const t of themes) {
    const cfg = getThemeConfig(t);
    const valid = cfg && typeof cfg.accent === 'string' && cfg.accent.length > 0
      && typeof cfg.bgColor === 'string' && typeof cfg.fontTitle === 'string';
    log(`3.1 主题 ${t}`, valid, `name=${cfg.name} accent=#${cfg.accent}`);
  }
}

// 3.2 未知主题回退 neon-green
{
  const cfg = getThemeConfig('unknown-theme');
  log('3.2 未知主题回退', cfg.name === '霓虹绿', `name=${cfg.name}`);
}

// 3.3 apple-dark 检测
{
  const cfg = getThemeConfig('apple-dark');
  log('3.3 isAppleDark', isAppleDark(cfg) === true);
  log('3.3a 纯黑背景', cfg.bgColor === '000000');
}

// 3.4 非 apple 主题
{
  const cfg = getThemeConfig('neon-green');
  log('3.4 非 apple', isAppleDark(cfg) === false);
}

// ============================================================================
// Part 4: 集成测试 — PPT 生成
// ============================================================================
console.log('\n═══ Part 4: 集成测试 — PPT 文件生成 ═══');

const standardContent = `# 产品介绍
## 下一代 AI 开发工具

# 行业背景
- 全球开发者数量突破 3000 万，年增长 15%
- 传统工具无法满足 AI 时代需求
- 企业效率要求提升 30%
- 代码质量与安全成为刚性需求
- 自动化覆盖率不断提高

# 核心价值
- 智能补全准确率 92%
- 多语言覆盖 50+ 编程语言
- Bug 检出率提升 80%
- 全链路自动化

# 市场数据统计
- 全球 AI 工具市场规模 380 亿美元
- 企业平均采用率 65%
- 用户满意度 4.5 分
- 年增长率 28%

# 技术架构
- 大语言模型层：CodeLLM 70B 参数
- 推理加速层：TensorRT + vLLM
- 上下文管理：RAG + 代码图谱
- 安全层：扫描 + 审计

# 实施步骤
- 第一步：需求分析与环境评估
- 第二步：定制化配置与集成
- 第三步：培训与试运行
- 第四步：正式上线与持续优化

# 应用效果
- 编码效率提升 60%
- 代码质量提升 40%
- 团队协作效率提升 200%
- 上手时间仅需 30 分钟

# 总结
## 感谢您的关注`;

// 4.1 所有 5 个常用主题
for (const theme of ['neon-green', 'neon-blue', 'neon-purple', 'apple-dark', 'corporate']) {
  const r = await generate({
    topic: '产品介绍', content: standardContent, theme, slides_count: 10,
    use_masters: true, chart_mode: 'auto',
  });
  log(`4.1 主题 ${theme}`, r.success, `${r.metadata?.slidesCount} slides, ${(r.metadata?.fileSize/1024).toFixed(0)}KB`);
}

// 4.2 Legacy 降级模式
{
  const r = await generate({
    topic: '产品介绍', content: standardContent, theme: 'neon-green', slides_count: 10,
    use_masters: false, chart_mode: 'none',
  });
  log('4.2 Legacy 模式', r.success, `${r.metadata?.slidesCount} slides`);
}

// 4.3 chart_mode=none 强制不出图表
{
  const chartContent = `# 数据报告\n## 分析\n# 市场数据统计\n- 收入 100 万\n- 收入 200 万\n- 收入 300 万\n# 谢谢`;
  const r = await generate({
    topic: '数据', content: chartContent, theme: 'neon-green', slides_count: 5,
    use_masters: true, chart_mode: 'none',
  });
  log('4.3 chart_mode=none', r.success);
}

// 4.4 图表自动检测（占比数据 → doughnut）
{
  const chartContent = `# 份额分析\n## 2026\n# 全球市场占比数据\n- 北美占比 38%\n- 欧洲占比 27%\n- 亚太占比 25%\n- 其他占比 10%\n# 谢谢`;
  const r = await generate({
    topic: '份额', content: chartContent, theme: 'neon-blue', slides_count: 5,
    use_masters: true, chart_mode: 'auto',
  });
  log('4.4 图表自动检测', r.success);
}

// 4.5 最小内容（1 个内容页）
{
  const r = await generate({
    topic: '简短', content: '# 标题\n## 副标题\n# 仅一页\n- 唯一要点\n# 谢谢',
    theme: 'corporate', slides_count: 3, use_masters: true, chart_mode: 'auto',
  });
  log('4.5 最小内容', r.success, `${r.metadata?.slidesCount} slides`);
}

// 4.6 无 content → 占位生成
{
  const r = await generate({
    topic: '自动占位', theme: 'apple-dark', slides_count: 8, use_masters: true, chart_mode: 'auto',
  });
  log('4.6 无 content 占位', r.success, `${r.metadata?.slidesCount} slides`);
}

// 4.7 大量内容（15 页请求，实际受 maxSlides 限制）
{
  const bigContent = Array.from({ length: 15 }, (_, i) =>
    `# 章节${i + 1}\n- 要点A\n- 要点B\n- 要点C`
  ).join('\n');
  const r = await generate({
    topic: '大量内容', content: bigContent, theme: 'neon-purple', slides_count: 15,
    use_masters: true, chart_mode: 'auto',
  });
  log('4.7 大量内容', r.success, `${r.metadata?.slidesCount} slides`);
}

// ============================================================================
// Part 5: 结构验证 — python-pptx 深度检查
// ============================================================================
console.log('\n═══ Part 5: 结构验证 — python-pptx 深度检查 ═══');

// 使用 neon-green 标准生成的文件做结构检查
const mainPptx = generatedFiles[0]; // neon-green

import { execSync } from 'child_process';
import * as os from 'os';

function pptxCheck(filePath, checkName, pythonExpr) {
  const tmpFile = path.join(os.tmpdir(), `ppt_test_${Date.now()}.py`);
  try {
    const code = [
      'from pptx import Presentation',
      `prs = Presentation("${filePath}")`,
      `result = ${pythonExpr.trim()}`,
      'print(result)',
    ].join('\n');
    fs.writeFileSync(tmpFile, code);
    const output = execSync(`python3 "${tmpFile}"`, { encoding: 'utf-8' }).trim();
    return output;
  } catch (e) {
    return 'ERROR: ' + e.message.slice(0, 200);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// 5.1 Slide 数量
{
  const count = pptxCheck(mainPptx, 'slide count', 'len(prs.slides)');
  log('5.1 Slide 数量', count === '8', `${count} slides`);
}

// 5.2 无空 Placeholder
{
  const result = pptxCheck(mainPptx, 'empty ph', `
sum(1 for slide in prs.slides for shape in slide.shapes
    if shape.is_placeholder and (shape.text_frame.text.strip() == '' or 'Click to add' in shape.text_frame.text))
`);
  log('5.2 无空 Placeholder', result === '0', `found ${result}`);
}

// 5.3 "核心价值"页无 STEP 标签
{
  const result = pptxCheck(mainPptx, 'no STEP on 核心价值', `
any(
    any(s.text_frame.text.startswith('STEP') for s in slide.shapes if s.has_text_frame)
    for slide in prs.slides
    if any('核心价值' in s.text_frame.text for s in slide.shapes if s.has_text_frame)
)
`);
  log('5.3 核心价值无 STEP', result === 'False');
}

// 5.4 末页使用 END master
{
  const result = pptxCheck(mainPptx, 'end master', `prs.slides[-1].slide_layout.name`);
  log('5.4 末页 END master', result === 'MASTER_END', result);
}

// 5.5 首页使用 TITLE master
{
  const result = pptxCheck(mainPptx, 'title master', `prs.slides[0].slide_layout.name`);
  log('5.5 首页 TITLE master', result === 'MASTER_TITLE', result);
}

// 5.6 布局多样性（至少 3 种 master）
{
  const result = pptxCheck(mainPptx, 'layout variety', `
len(set(slide.slide_layout.name for slide in prs.slides))
`);
  const n = parseInt(result);
  log('5.6 布局多样性', n >= 3, `${n} distinct masters`);
}

// 5.7 图表检测文件（4.4 doughnut chart）
{
  const chartFile = generatedFiles[7]; // 4.4 chart auto doughnut
  if (chartFile) {
    const result = pptxCheck(chartFile, 'chart exists', `
sum(1 for slide in prs.slides for shape in slide.shapes if shape.has_chart)
`);
    log('5.7 图表文件含图表', parseInt(result) >= 1, `${result} chart(s)`);

    const chartType = pptxCheck(chartFile, 'chart type', `
next((str(shape.chart.chart_type) for slide in prs.slides for shape in slide.shapes if shape.has_chart), 'none')
`);
    log('5.7a 图表类型=DOUGHNUT', chartType.includes('DOUGHNUT'), chartType);
  }
}

// 5.8 chart_mode=none 文件无图表
{
  const noChartFile = generatedFiles[6]; // 4.3 chart_mode=none
  if (noChartFile) {
    const result = pptxCheck(noChartFile, 'no chart', `
sum(1 for slide in prs.slides for shape in slide.shapes if shape.has_chart)
`);
    log('5.8 no-chart 无图表', result === '0');
  }
}

// 5.9 apple-dark 无大装饰元素
{
  const appleFile = generatedFiles[3]; // apple-dark
  if (appleFile) {
    const result = pptxCheck(appleFile, 'no big decor', `
sum(1 for slide in prs.slides for shape in slide.shapes
    if not shape.has_text_frame and not shape.is_placeholder and not shape.has_chart
    and shape.width/914400 > 3 and shape.height/914400 > 3)
`);
    log('5.9 apple-dark 无大装饰', result === '0', `${result} large shapes`);
  }
}

// 5.10 "实施步骤"页有 STEP 标签（timeline 正确触发）
{
  const result = pptxCheck(mainPptx, 'steps on 步骤', `
any(
    any(s.text_frame.text.startswith('STEP') for s in slide.shapes if s.has_text_frame)
    for slide in prs.slides
    if any('步骤' in s.text_frame.text for s in slide.shapes if s.has_text_frame)
)
`);
  log('5.10 "步骤"页有 STEP', result === 'True');
}

// ============================================================================
// 清理 + 汇总
// ============================================================================
console.log('\n═══ 清理测试文件 ═══');
for (const f of generatedFiles) {
  try { fs.unlinkSync(f); } catch {}
}
console.log(`  已清理 ${generatedFiles.length} 个测试 PPT 文件`);

console.log('\n═══ 测试完成 ═══');
if (process.exitCode) {
  console.log('❌ 存在失败用例，请检查');
} else {
  console.log('✅ 全部通过');
}
