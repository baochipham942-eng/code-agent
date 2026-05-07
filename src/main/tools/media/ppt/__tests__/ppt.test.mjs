// ============================================================================
// PPT 生成系统 — Helper 单元测试
// 运行: npx tsx src/main/tools/media/ppt/__tests__/ppt.test.mjs
// ============================================================================
// History: 原文件包含 Part 4 (集成测试) + Part 5 (python-pptx 结构验证)，
// 依赖已删除的 src/main/tools/media/ppt/index.ts (pptGenerateTool)。
// 顶层 ppt_generate 工具 API + schema 已被 tests/unit/tools/modules/network/
// pptGenerate.test.ts 用 vitest 覆盖（13 cases），此文件只保留 helper 单测。
// ============================================================================

import { createRequire } from 'module';
import * as path from 'path';

const projectRequire = createRequire(
  path.resolve('/Users/linchen/Downloads/ai/code-agent/package.json')
);
globalThis.require = projectRequire;

const { parseContentToSlides, generatePlaceholderSlides } = await import('../parser.ts');
const { detectChartData } = await import('../charts.ts');
const { getThemeConfig, isAppleDark } = await import('../themes.ts');

function log(name, ok, detail = '') {
  const icon = ok ? '✅' : '❌';
  console.log(`  ${icon} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
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
  log('3.3a 深色背景', cfg.bgColor === '06060e' || cfg.bgColor === '000000');
}

// 3.4 非 apple 主题
{
  const cfg = getThemeConfig('neon-green');
  log('3.4 非 apple', isAppleDark(cfg) === false);
}

// ============================================================================
// Part 4 + Part 5 (集成测试 + python-pptx 结构验证) 已迁移至 vitest，参见
//   tests/unit/tools/modules/network/pptGenerate.test.ts
//   tests/unit/tools/modules/network/pptEdit.test.ts
// ============================================================================

console.log('\n═══ 测试完成 ═══');
if (process.exitCode) {
  console.log('❌ 存在失败用例，请检查');
} else {
  console.log('✅ 全部通过');
}
