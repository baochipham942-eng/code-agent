// ============================================================================
// PPT 生成系统 — 扩展测试（布局精确性 + 边界条件 + 全主题 + 回归）
// 运行: npx tsx src/main/tools/media/ppt/__tests__/ppt-extended.test.mjs
// ============================================================================

import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const projectRequire = createRequire(
  path.resolve('/Users/linchen/Downloads/ai/code-agent/package.json')
);
globalThis.require = projectRequire;

const { pptGenerateTool } = await import('../index.ts');
const { parseContentToSlides } = await import('../parser.ts');
const { detectChartData } = await import('../charts.ts');
const { selectMasterAndLayout } = await import('../layouts.ts');

const WD = '/Users/linchen/Downloads/ai/code-agent';
const generatedFiles = [];
let pass = 0, fail = 0;

function log(name, ok, detail = '') {
  const icon = ok ? '✅' : '❌';
  console.log(`  ${icon} ${name}${detail ? ' — ' + detail : ''}`);
  if (ok) pass++; else { fail++; process.exitCode = 1; }
}

async function generate(params) {
  const r = await pptGenerateTool.execute(params, { workingDirectory: WD });
  if (r.success && r.metadata?.filePath) generatedFiles.push(r.metadata.filePath);
  return r;
}

function pyCheck(filePath, pythonExpr) {
  const tmpFile = path.join(os.tmpdir(), `ppt_ext_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.py`);
  try {
    const code = [
      'from pptx import Presentation',
      `prs = Presentation("${filePath}")`,
      `result = ${pythonExpr.trim()}`,
      'print(result)',
    ].join('\n');
    fs.writeFileSync(tmpFile, code);
    return execSync(`python3 "${tmpFile}"`, { encoding: 'utf-8' }).trim();
  } catch (e) {
    return 'ERROR: ' + e.message.slice(0, 200);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ============================================================================
// Part A: 布局选择精确性测试
// 每种布局类型用精确内容命中，验证 selectMasterAndLayout 返回正确结果
// ============================================================================
console.log('\n═══ Part A: 布局选择精确性 ═══');

// A.1 isTechnical → cards-2
{
  const slide = { title: '技术架构概览', points: ['模块A', '模块B', '模块C', '模块D'], isTitle: false, isEnd: false };
  const { layout } = selectMasterAndLayout(slide, false, 'auto');
  log('A.1 isTechnical → cards-2', layout === 'cards-2', layout);
}

// A.2 isProcess → timeline
{
  const slide = { title: '实施步骤', points: ['步骤A', '步骤B', '步骤C'], isTitle: false, isEnd: false };
  const { layout } = selectMasterAndLayout(slide, false, 'auto');
  log('A.2 isProcess → timeline', layout === 'timeline', layout);
}

// A.3 isKeyPoint → highlight (≤4 points)
{
  const slide = { title: '核心价值', points: ['价值1', '价值2', '价值3'], isTitle: false, isEnd: false };
  const { layout } = selectMasterAndLayout(slide, false, 'auto');
  log('A.3 isKeyPoint → highlight', layout === 'highlight', layout);
}

// A.4 isComparison → cards-2
{
  const slide = { title: '方案对比分析', points: ['优势A', '优势B', '劣势C'], isTitle: false, isEnd: false };
  const { layout } = selectMasterAndLayout(slide, false, 'auto');
  log('A.4 isComparison → cards-2', layout === 'cards-2', layout);
}

// A.5 hasNumbers → stats (3-5 points with numbers)
{
  const slide = { title: '市场数据分析', points: [
    '市场规模 380 亿美元', '增长率 28%', '采用率 65%', '满意度 4.5 分'
  ], isTitle: false, isEnd: false };
  const { layout } = selectMasterAndLayout(slide, false, 'auto');
  log('A.5 hasNumbers → stats', layout === 'stats', layout);
}

// A.6 3 points (no keyword match) → cards-3
{
  const slide = { title: '产品特色', points: ['特色A', '特色B', '特色C'], isTitle: false, isEnd: false };
  const { layout } = selectMasterAndLayout(slide, false, 'auto');
  log('A.6 3 points → cards-3', layout === 'cards-3', layout);
}

// A.7 ≤2 points → highlight
{
  const slide = { title: '概述', points: ['要点A', '要点B'], isTitle: false, isEnd: false };
  const { layout } = selectMasterAndLayout(slide, false, 'auto');
  log('A.7 ≤2 points → highlight', layout === 'highlight', layout);
}

// A.8 isTitle → MASTER_TITLE
{
  const slide = { title: '演示标题', subtitle: '副标题', points: [], isTitle: true, isEnd: false };
  const { master } = selectMasterAndLayout(slide, false, 'auto');
  log('A.8 isTitle → MASTER_TITLE', master === 'MASTER_TITLE', master);
}

// A.9 isEnd → MASTER_END
{
  const slide = { title: '谢谢', points: [], isTitle: false, isEnd: true };
  const { master } = selectMasterAndLayout(slide, false, 'auto');
  log('A.9 isEnd → MASTER_END', master === 'MASTER_END', master);
}

// A.10 hasImages → MASTER_CONTENT_IMAGE
{
  const slide = { title: '图片页', points: ['说明'], isTitle: false, isEnd: false };
  const { master } = selectMasterAndLayout(slide, true, 'auto');
  log('A.10 hasImages → IMAGE master', master === 'MASTER_CONTENT_IMAGE', master);
}

// A.11 chart auto with valid data → MASTER_CONTENT_CHART
{
  const slide = { title: '全球市场占比数据', points: [
    '北美 38%', '欧洲 27%', '亚太 25%', '其他 10%'
  ], isTitle: false, isEnd: false };
  const { master, layout, chartData } = selectMasterAndLayout(slide, false, 'auto');
  log('A.11 chart auto → CHART master', master === 'MASTER_CONTENT_CHART', master);
  log('A.11a layout=chart', layout === 'chart');
  log('A.11b chartData not null', chartData !== null);
}

// A.12 chart_mode=none → 不生成图表
{
  const slide = { title: '全球市场占比数据', points: [
    '北美 38%', '欧洲 27%', '亚太 25%', '其他 10%'
  ], isTitle: false, isEnd: false };
  const { master, chartData } = selectMasterAndLayout(slide, false, 'none');
  log('A.12 chart_mode=none → 无图表', chartData === null);
  log('A.12a 非 CHART master', master !== 'MASTER_CONTENT_CHART', master);
}

// A.13 优先级：isTechnical > isProcess（标题含两者）
{
  const slide = { title: '技术实施步骤', points: ['A', 'B', 'C', 'D'], isTitle: false, isEnd: false };
  const { layout } = selectMasterAndLayout(slide, false, 'auto');
  log('A.13 isTechnical > isProcess', layout === 'cards-2', layout);
}

// A.14 优先级：isKeyPoint > hasNumbers
{
  const slide = { title: '核心数据价值', points: [
    '收入 100 万', '增长 50%', '用户 200 万'
  ], isTitle: false, isEnd: false };
  const { layout } = selectMasterAndLayout(slide, false, 'auto');
  log('A.14 isKeyPoint > hasNumbers', layout === 'highlight', layout);
}

// A.15 isKeyPoint with >4 points → 不走 highlight（fallback to rotation）
{
  const slide = { title: '核心价值', points: ['A', 'B', 'C', 'D', 'E'], isTitle: false, isEnd: false };
  const { layout } = selectMasterAndLayout(slide, false, 'auto');
  log('A.15 isKeyPoint >4 pts → 不走 highlight', layout !== 'highlight', layout);
}

// ============================================================================
// Part B: 全 9 主题生成验证
// ============================================================================
console.log('\n═══ Part B: 全 9 主题生成 ═══');

const allThemes = [
  'neon-green', 'neon-blue', 'neon-purple', 'neon-orange',
  'glass-light', 'glass-dark', 'minimal-mono', 'corporate', 'apple-dark'
];

const themeContent = `# 主题测试
## 全面验证

# 行业概况
- 全球市场规模突破 500 亿美元
- 企业数字化转型率达到 75%
- 人均效率提升 40%
- 自动化覆盖率不断攀升
- 合规需求日益严格

# 核心优势
- 领先的技术架构设计
- 全面覆盖业务场景
- 极致的用户体验

# 技术架构
- 微服务层：Spring Cloud
- 数据层：PostgreSQL + Redis
- 消息队列：Kafka
- 监控：Prometheus + Grafana

# 谢谢`;

for (const theme of allThemes) {
  const r = await generate({
    topic: '主题测试', content: themeContent, theme, slides_count: 8,
    use_masters: true, chart_mode: 'auto',
  });
  log(`B.1 主题 ${theme}`, r.success,
    `${r.metadata?.slidesCount} slides, ${(r.metadata?.fileSize / 1024).toFixed(0)}KB`);
}

// 对每个主题做 python-pptx 基础结构检查
console.log('\n  --- 结构验证 ---');
for (let i = 0; i < allThemes.length; i++) {
  const f = generatedFiles[i];
  const theme = allThemes[i];

  // 无空 placeholder
  const emptyPh = pyCheck(f, `
sum(1 for slide in prs.slides for shape in slide.shapes
    if shape.is_placeholder and (shape.text_frame.text.strip() == '' or 'Click to add' in shape.text_frame.text))
`);
  log(`B.2 ${theme} 无空 PH`, emptyPh === '0', `${emptyPh} empty`);

  // 首页 TITLE + 末页 END
  const firstMaster = pyCheck(f, `prs.slides[0].slide_layout.name`);
  const lastMaster = pyCheck(f, `prs.slides[-1].slide_layout.name`);
  log(`B.3 ${theme} 首页 TITLE`, firstMaster === 'MASTER_TITLE', firstMaster);
  log(`B.4 ${theme} 末页 END`, lastMaster === 'MASTER_END', lastMaster);
}

// ============================================================================
// Part C: 边界条件测试
// ============================================================================
console.log('\n═══ Part C: 边界条件 ═══');

// C.1 单幻灯片（只有标题+结尾）
{
  const r = await generate({
    topic: '极简', content: '# 标题\n## 副标题\n# 谢谢',
    theme: 'neon-green', slides_count: 2, use_masters: true, chart_mode: 'auto',
  });
  log('C.1 仅标题+结尾', r.success, `${r.metadata?.slidesCount} slides`);
}

// C.2 超长标题
{
  const longTitle = 'A'.repeat(200);
  const r = await generate({
    topic: longTitle, content: `# ${longTitle}\n## Sub\n# 内容页\n- 要点\n# 谢谢`,
    theme: 'neon-blue', slides_count: 5, use_masters: true, chart_mode: 'auto',
  });
  log('C.2 超长标题 (200 chars)', r.success);
}

// C.3 超长要点
{
  const longPoint = '这是一个非常长的要点，' + '内容重复测试。'.repeat(30);
  const r = await generate({
    topic: '长文本', content: `# 标题\n## 副\n# 内容页\n- ${longPoint}\n- 短要点\n- 另一个\n# 谢谢`,
    theme: 'neon-purple', slides_count: 5, use_masters: true, chart_mode: 'auto',
  });
  log('C.3 超长要点', r.success);
}

// C.4 包含特殊字符
{
  const r = await generate({
    topic: '特殊字符', content: `# 标题 <script>alert("xss")</script>
## 副标题 & "引号" 'single'
# 内容页
- 要点含 <b>HTML</b> 标签
- 路径 C:\\Users\\test\\file.txt
- URL https://example.com?a=1&b=2
# 谢谢`,
    theme: 'corporate', slides_count: 5, use_masters: true, chart_mode: 'auto',
  });
  log('C.4 特殊字符', r.success);
}

// C.5 包含 emoji
{
  const r = await generate({
    topic: 'Emoji 测试', content: `# 🚀 产品发布
## 🎉 新功能上线
# 主要特点
- 🧠 智能推荐引擎
- ⚡ 极速响应
- 🔒 安全可靠
# 🙏 感谢关注`,
    theme: 'apple-dark', slides_count: 5, use_masters: true, chart_mode: 'auto',
  });
  log('C.5 Emoji 内容', r.success);
}

// C.6 纯英文内容
{
  const r = await generate({
    topic: 'English Only', content: `# Product Launch
## Next Generation Platform

# Key Features
- AI-powered code completion with 95% accuracy
- Real-time collaboration for distributed teams
- Enterprise-grade security and compliance

# Market Overview
- Total addressable market: $50B
- Year-over-year growth: 35%
- Customer satisfaction: 4.8/5.0

# Thank You`,
    theme: 'glass-dark', slides_count: 5, use_masters: true, chart_mode: 'auto',
  });
  log('C.6 纯英文', r.success);
}

// C.7 slides_count=1（极限）
{
  const r = await generate({
    topic: '单页', content: '# 唯一页面\n- 仅一个要点',
    theme: 'minimal-mono', slides_count: 1, use_masters: true, chart_mode: 'auto',
  });
  log('C.7 slides_count=1', r.success, `${r.metadata?.slidesCount} slides`);
}

// C.8 slides_count=20（上限）
{
  const bigContent = Array.from({ length: 20 }, (_, i) =>
    `# 第${i + 1}章\n- 内容A\n- 内容B\n- 内容C`
  ).join('\n');
  const r = await generate({
    topic: '大量', content: bigContent, theme: 'neon-orange', slides_count: 20,
    use_masters: true, chart_mode: 'auto',
  });
  log('C.8 slides_count=20', r.success, `${r.metadata?.slidesCount} slides`);
}

// ============================================================================
// Part D: 回归验证 — 之前修复的 bug
// ============================================================================
console.log('\n═══ Part D: 回归验证 ═══');

// D.1 "核心价值" 不走 timeline（isProcess false positive 回归）
{
  const slides = parseContentToSlides(`# 标题\n## 副\n# 核心价值\n- 智能补全准确率 92%\n- 多语言覆盖 50+ 编程语言\n- Bug 检出率提升 80%\n- 全链路自动化\n# 谢谢`, 10);
  const coreSlide = slides.find(s => s.title.includes('核心价值'));
  const { layout } = selectMasterAndLayout(coreSlide, false, 'auto');
  log('D.1 核心价值 ≠ timeline', layout !== 'timeline', layout);
  log('D.1a 核心价值 = highlight', layout === 'highlight', layout);
}

// D.2 数量级不一致数据不生成图表（magnitude 回归）
{
  const data = detectChartData('市场数据与趋势', [
    'AI 编程工具市场规模 150 亿美元',
    '企业采用率从 15% 增长至 68%',
    '开发者满意度评分 4.7/5.0',
    '代码生成速度提升 320%',
    '年复合增长率 CAGR 35%',
  ]);
  log('D.2 混合数量级 → null', data === null);
}

// D.3 "感谢关注" 识别为 End 页（End detection 回归）
{
  const slides = parseContentToSlides('# 标题\n# 感谢关注\n## 欢迎联系', 10);
  const last = slides[slides.length - 1];
  log('D.3 "感谢关注" → isEnd', last.isEnd === true);
}

// D.4 "总结" 识别为 End 页
{
  const slides = parseContentToSlides('# 标题\n# 总结', 10);
  const last = slides[slides.length - 1];
  log('D.4 "总结" → isEnd', last.isEnd === true);
}

// D.5 hasNumbers 需要 ≥3 个才触发 stats（threshold 回归）
{
  const slide = { title: '产品功能', points: [
    '支持 50+ 编程语言', '内置模板系统', '实时预览功能', '多平台部署'
  ], isTitle: false, isEnd: false };
  const { layout } = selectMasterAndLayout(slide, false, 'auto');
  log('D.5 仅 1 个数字 → 非 stats', layout !== 'stats', layout);
}

// D.6 "实施步骤" → timeline 正常触发
{
  const slide = { title: '实施步骤', points: [
    '第一步：环境搭建', '第二步：配置部署', '第三步：功能验证', '第四步：上线运行'
  ], isTitle: false, isEnd: false };
  const { layout } = selectMasterAndLayout(slide, false, 'auto');
  log('D.6 实施步骤 → timeline', layout === 'timeline', layout);
}

// D.7 描述性 label 过长 → 不生成图表（label length guard）
{
  const data = detectChartData('产品功能介绍', [
    '支持超过 50 种编程语言和框架体系',
    '内置 200 个常用代码模板和最佳实践',
    '兼容 30 款主流 IDE 开发工具',
  ]);
  log('D.7 长描述 label → null', data === null);
}

// ============================================================================
// Part E: Legacy vs Master 模式对比
// ============================================================================
console.log('\n═══ Part E: Legacy vs Master 对比 ═══');

const compareContent = `# 对比测试
## Legacy vs Master

# 行业背景
- 全球开发者 3000 万人
- 企业数字化率 75%
- 效率需求增长 30%
- 安全合规成为刚性需求
- 自动化趋势明显

# 核心价值
- 智能补全 92% 准确率
- 50+ 语言覆盖
- Bug 检出率 80%

# 实施步骤
- 第一步：需求分析
- 第二步：配置部署
- 第三步：测试验证
- 第四步：正式上线

# 总结`;

const masterR = await generate({
  topic: '对比测试', content: compareContent, theme: 'neon-green', slides_count: 8,
  use_masters: true, chart_mode: 'auto',
});
const legacyR = await generate({
  topic: '对比测试', content: compareContent, theme: 'neon-green', slides_count: 8,
  use_masters: false, chart_mode: 'none',
});

log('E.1 Master 模式成功', masterR.success);
log('E.2 Legacy 模式成功', legacyR.success);
log('E.3 Slide 数量一致',
  masterR.metadata?.slidesCount === legacyR.metadata?.slidesCount,
  `master=${masterR.metadata?.slidesCount} legacy=${legacyR.metadata?.slidesCount}`);

// python-pptx 验证 Legacy
if (legacyR.success) {
  const legacyFile = generatedFiles[generatedFiles.length - 1];
  const emptyPh = pyCheck(legacyFile, `
sum(1 for slide in prs.slides for shape in slide.shapes
    if shape.is_placeholder and (shape.text_frame.text.strip() == '' or 'Click to add' in shape.text_frame.text))
`);
  log('E.4 Legacy 无空 PH', emptyPh === '0', `${emptyPh} empty`);

  // Legacy "实施步骤" 有 STEP
  const hasStep = pyCheck(legacyFile, `
any(
    any(s.text_frame.text.startswith('STEP') for s in slide.shapes if s.has_text_frame)
    for slide in prs.slides
    if any('步骤' in s.text_frame.text for s in slide.shapes if s.has_text_frame)
)
`);
  log('E.5 Legacy "步骤" 有 STEP', hasStep === 'True');

  // Legacy "核心价值" 无 STEP
  const noStep = pyCheck(legacyFile, `
any(
    any(s.text_frame.text.startswith('STEP') for s in slide.shapes if s.has_text_frame)
    for slide in prs.slides
    if any('核心价值' in s.text_frame.text for s in slide.shapes if s.has_text_frame)
)
`);
  log('E.6 Legacy "核心价值" 无 STEP', noStep === 'False');
}

// ============================================================================
// Part F: 图表类型验证
// ============================================================================
console.log('\n═══ Part F: 图表类型验证 ═══');

// F.1 柱状图（标准数据）
{
  const r = await generate({
    topic: '柱状图', content: `# 报告\n## 数据\n# 季度收入数据\n- Q1 收入 1200 万\n- Q2 收入 1500 万\n- Q3 收入 1800 万\n- Q4 收入 2200 万\n# 谢谢`,
    theme: 'neon-green', slides_count: 5, use_masters: true, chart_mode: 'auto',
  });
  log('F.1 柱状图生成', r.success);
  if (r.success) {
    const f = generatedFiles[generatedFiles.length - 1];
    const chartCount = pyCheck(f, `sum(1 for s in prs.slides for sh in s.shapes if sh.has_chart)`);
    log('F.1a 含图表', parseInt(chartCount) >= 1, `${chartCount} charts`);
  }
}

// F.2 环形图（占比数据）
{
  const r = await generate({
    topic: '环形图', content: `# 报告\n## 分析\n# 全球市场份额占比\n- 产品A 占比 45%\n- 产品B 占比 30%\n- 产品C 占比 15%\n- 产品D 占比 10%\n# 谢谢`,
    theme: 'neon-blue', slides_count: 5, use_masters: true, chart_mode: 'auto',
  });
  log('F.2 环形图生成', r.success);
  if (r.success) {
    const f = generatedFiles[generatedFiles.length - 1];
    const chartType = pyCheck(f, `
next((str(shape.chart.chart_type) for slide in prs.slides for shape in slide.shapes if shape.has_chart), 'none')
`);
    log('F.2a 类型=DOUGHNUT', chartType.includes('DOUGHNUT'), chartType);
  }
}

// F.3 折线图（趋势数据）
{
  const r = await generate({
    topic: '折线图', content: `# 报告\n## 趋势\n# 年度增长趋势\n- 2022年收入 800 万\n- 2023年收入 1200 万\n- 2024年收入 1800 万\n- 2025年收入 2500 万\n# 谢谢`,
    theme: 'apple-dark', slides_count: 5, use_masters: true, chart_mode: 'auto',
  });
  log('F.3 折线图生成', r.success);
  if (r.success) {
    const f = generatedFiles[generatedFiles.length - 1];
    const chartType = pyCheck(f, `
next((str(shape.chart.chart_type) for slide in prs.slides for shape in slide.shapes if shape.has_chart), 'none')
`);
    log('F.3a 类型含 LINE', chartType.includes('LINE'), chartType);
  }
}

// ============================================================================
// 清理 + 汇总
// ============================================================================
console.log('\n═══ 清理测试文件 ═══');
for (const f of generatedFiles) {
  try { fs.unlinkSync(f); } catch {}
}
console.log(`  已清理 ${generatedFiles.length} 个测试 PPT 文件`);

console.log(`\n═══ 扩展测试完成：${pass} pass / ${fail} fail ═══`);
if (fail) {
  console.log(`❌ ${fail} 个用例失败`);
} else {
  console.log('✅ 全部通过');
}
