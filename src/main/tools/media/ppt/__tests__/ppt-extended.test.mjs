// ============================================================================
// PPT 生成系统 — 扩展测试 Part A（布局选择精确性）
// 运行: npx tsx src/main/tools/media/ppt/__tests__/ppt-extended.test.mjs
// ============================================================================
// History: Part B/C/D/E/F (全主题生成 / 边界 / 回归 / 对比 / 图表) 依赖已删除
// 的 src/main/tools/media/ppt/index.ts (pptGenerateTool)。顶层工具 API + 9 主题
// 已被 tests/unit/tools/modules/network/pptGenerate.test.ts 用 vitest 覆盖。
// 此文件保留 Part A — selectMasterAndLayout 路由决策的纯函数测试。
// ============================================================================

import { createRequire } from 'module';
import * as path from 'path';

const projectRequire = createRequire(
  path.resolve('/Users/linchen/Downloads/ai/code-agent/package.json')
);
globalThis.require = projectRequire;

const { selectMasterAndLayout } = await import('../layouts.ts');

let pass = 0, fail = 0;

function log(name, ok, detail = '') {
  const icon = ok ? '✅' : '❌';
  console.log(`  ${icon} ${name}${detail ? ' — ' + detail : ''}`);
  if (ok) pass++; else { fail++; process.exitCode = 1; }
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
// Part B/C/D/E/F (全主题 / 边界 / 回归 / 对比 / 图表) 已迁移至 vitest，参见
//   tests/unit/tools/modules/network/pptGenerate.test.ts
// ============================================================================

console.log(`\n═══ 扩展测试完成：${pass} pass / ${fail} fail ═══`);
if (fail) {
  console.log(`❌ ${fail} 个用例失败`);
} else {
  console.log('✅ 全部通过');
}
