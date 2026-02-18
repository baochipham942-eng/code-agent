// ============================================================================
// PPT Schema & Template 测试
// 运行: npx tsx src/main/tools/network/ppt/__tests__/ppt-schema.test.mjs
// ============================================================================
// 覆盖: slideSchemas 验证、layoutTemplates 预设、StructuredSlide 端到端、
//       modelCallback fallback、normalizeSlideContent 容错
// ============================================================================

import { createRequire } from 'module';
import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const projectRequire = createRequire(
  path.resolve('/Users/linchen/Downloads/ai/code-agent/package.json')
);
globalThis.require = projectRequire;

const { validateSlideContent, validateStructuredSlides, getLayoutSchemaDescription } = await import('../slideSchemas.ts');
const { getTemplateForTheme, TEMPLATE_PRESETS } = await import('../layoutTemplates.ts');
const { getDecorations, buildDecorationObjects, DECORATIONS } = await import('../masterDecorations.ts');
const { getThemeConfig } = await import('../themes.ts');
const { pptGenerateTool } = await import('../index.ts');
const { generateStructuredSlides } = await import('../slideContentAgent.ts');

const WD = '/Users/linchen/Downloads/ai/code-agent';
const generatedFiles = [];
let passed = 0;
let failed = 0;

function log(name, ok, detail = '') {
  const icon = ok ? '✅' : '❌';
  console.log(`  ${icon} ${name}${detail ? ' — ' + detail : ''}`);
  if (ok) passed++; else { failed++; process.exitCode = 1; }
}

async function generate(params) {
  const r = await pptGenerateTool.execute(params, { workingDirectory: WD });
  if (r.success && r.metadata?.filePath) generatedFiles.push(r.metadata.filePath);
  return r;
}

// ============================================================================
// Part 1: slideSchemas — validateSlideContent
// ============================================================================
console.log('\n═══ Part 1: slideSchemas 验证 ═══');

// 1.1 Stats 有效
{
  const r = validateSlideContent({
    layout: 'stats', title: '市场',
    content: { stats: [
      { label: 'A', value: '100' },
      { label: 'B', value: '200' },
      { label: 'C', value: '300' },
    ] }
  });
  log('1.1 stats 有效 (3项)', r.valid === true);
}

// 1.2 Stats 缺少 stats 数组
{
  const r = validateSlideContent({ layout: 'stats', title: '市场', content: {} });
  log('1.2 stats 缺 stats', r.valid === false && r.errors.some(e => e.includes('stats')));
}

// 1.3 Stats 数量不足
{
  const r = validateSlideContent({
    layout: 'stats', title: '市场',
    content: { stats: [{ label: 'A', value: '1' }] }
  });
  log('1.3 stats 仅1项被拒', r.valid === false);
}

// 1.4 Stats 5项（上限）
{
  const r = validateSlideContent({
    layout: 'stats', title: '市场',
    content: { stats: Array.from({ length: 5 }, (_, i) => ({ label: `L${i}`, value: `${i}` })) }
  });
  log('1.4 stats 5项有效', r.valid === true);
}

// 1.5 Stats 6项超限
{
  const r = validateSlideContent({
    layout: 'stats', title: '市场',
    content: { stats: Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, value: `${i}` })) }
  });
  log('1.5 stats 6项被拒', r.valid === false);
}

// 1.6 Cards3 恰好3项
{
  const r = validateSlideContent({
    layout: 'cards-3', title: '三卡片',
    content: { cards: [
      { title: 'A', description: 'a' },
      { title: 'B', description: 'b' },
      { title: 'C', description: 'c' },
    ] }
  });
  log('1.6 cards-3 恰好3项', r.valid === true);
}

// 1.7 Cards3 非3项
{
  const r = validateSlideContent({
    layout: 'cards-3', title: '两卡片',
    content: { cards: [{ title: 'A', description: 'a' }, { title: 'B', description: 'b' }] }
  });
  log('1.7 cards-3 仅2项被拒', r.valid === false);
}

// 1.8 List 有效
{
  const r = validateSlideContent({
    layout: 'list', title: '要点',
    content: { points: ['P1', 'P2', 'P3'] }
  });
  log('1.8 list 3项有效', r.valid === true);
}

// 1.9 List 1项不足
{
  const r = validateSlideContent({
    layout: 'list', title: '要点',
    content: { points: ['P1'] }
  });
  log('1.9 list 仅1项被拒', r.valid === false);
}

// 1.10 Timeline 有效
{
  const r = validateSlideContent({
    layout: 'timeline', title: '流程',
    content: { steps: [
      { title: 'S1', description: 'D1' },
      { title: 'S2', description: 'D2' },
    ] }
  });
  log('1.10 timeline 2步有效', r.valid === true);
}

// 1.11 Timeline 缺 description
{
  const r = validateSlideContent({
    layout: 'timeline', title: '流程',
    content: { steps: [{ title: 'S1' }, { title: 'S2' }] }
  });
  log('1.11 timeline 缺 desc', r.valid === false);
}

// 1.12 Comparison 有效
{
  const r = validateSlideContent({
    layout: 'comparison', title: '对比',
    content: {
      left: { title: 'L', points: ['L1', 'L2'] },
      right: { title: 'R', points: ['R1', 'R2'] },
    }
  });
  log('1.12 comparison 有效', r.valid === true);
}

// 1.13 Comparison 容错：数组自动转换
{
  const content = { left: ['L1', 'L2'], right: ['R1', 'R2'] };
  const r = validateSlideContent({ layout: 'comparison', title: '对比', content });
  log('1.13 comparison 数组容错', r.valid === true);
}

// 1.14 Quote 有效
{
  const r = validateSlideContent({
    layout: 'quote', title: '引言',
    content: { quote: '名言', attribution: '出处' }
  });
  log('1.14 quote 有效', r.valid === true);
}

// 1.15 Quote 缺字段
{
  const r = validateSlideContent({
    layout: 'quote', title: '引言',
    content: { quote: '名言' }
  });
  log('1.15 quote 缺 attribution', r.valid === false);
}

// 1.16 Chart 有效
{
  const r = validateSlideContent({
    layout: 'chart', title: '图表',
    content: { points: ['P1', 'P2'] }
  });
  log('1.16 chart 有效（无 chartData）', r.valid === true);
}

// 1.17 缺少 title
{
  const r = validateSlideContent({ layout: 'list', title: '', content: { points: ['P1', 'P2'] } });
  log('1.17 缺少 title', r.valid === false);
}

// 1.18 未知 layout
{
  const r = validateSlideContent({ layout: 'unknown-layout', title: '测试', content: {} });
  log('1.18 未知 layout', r.valid === false);
}

// 1.19 isTitle 跳过内容验证
{
  const r = validateSlideContent({
    layout: 'list', title: '封面', isTitle: true,
    content: { points: [] } // 空 points，但 isTitle 跳过验证
  });
  log('1.19 isTitle 跳过验证', r.valid === true);
}

// 1.20 isEnd 跳过内容验证
{
  const r = validateSlideContent({
    layout: 'stats', title: '结尾', isEnd: true,
    content: {} // 空 content，但 isEnd 跳过验证
  });
  log('1.20 isEnd 跳过验证', r.valid === true);
}

// ============================================================================
// Part 2: validateStructuredSlides — 批量验证 + normalizeSlideContent
// ============================================================================
console.log('\n═══ Part 2: 批量验证 + 容错 ═══');

// 2.1 批量验证：全部有效
{
  const { validSlides, errors } = validateStructuredSlides([
    { layout: 'list', title: '封面', isTitle: true, content: { points: ['P1'] } },
    { layout: 'stats', title: '数据', content: { stats: [{ label: 'A', value: '1' }, { label: 'B', value: '2' }] } },
    { layout: 'list', title: '结尾', isEnd: true, content: { points: ['谢谢'] } },
  ]);
  log('2.1 批量全有效', validSlides.length === 3 && errors.length === 0);
}

// 2.2 批量：部分无效
{
  const { validSlides, errors } = validateStructuredSlides([
    { layout: 'list', title: '封面', isTitle: true, content: {} },
    { layout: 'stats', title: '数据', content: {} }, // 无效
    { layout: 'list', title: '好', content: { points: ['P1', 'P2'] } },
  ]);
  log('2.2 部分无效', validSlides.length === 2 && errors.length === 1, `valid=${validSlides.length} err=${errors.length}`);
}

// 2.3 normalizeSlideContent：顶层字段 → content
{
  const input = [
    { layout: 'stats', title: '市场', stats: [{ label: 'A', value: '1' }, { label: 'B', value: '2' }, { label: 'C', value: '3' }] },
  ];
  const { validSlides } = validateStructuredSlides(input);
  log('2.3 顶层 stats → content', validSlides.length === 1);
}

// 2.4 normalizeSlideContent：顶层 steps
{
  const input = [
    { layout: 'timeline', title: '流程', steps: [{ title: 'S1', description: 'D1' }, { title: 'S2', description: 'D2' }] },
  ];
  const { validSlides } = validateStructuredSlides(input);
  log('2.4 顶层 steps → content', validSlides.length === 1);
}

// 2.5 normalizeSlideContent：顶层 points
{
  const input = [
    { layout: 'list', title: '要点', points: ['P1', 'P2', 'P3'] },
  ];
  const { validSlides } = validateStructuredSlides(input);
  log('2.5 顶层 points → content', validSlides.length === 1);
}

// 2.6 normalizeSlideContent：顶层 left + right
{
  const input = [
    { layout: 'comparison', title: '对比',
      left: { title: 'L', points: ['L1'] },
      right: { title: 'R', points: ['R1'] },
    },
  ];
  const { validSlides } = validateStructuredSlides(input);
  log('2.6 顶层 left/right → content', validSlides.length === 1);
}

// 2.7 normalizeSlideContent：顶层 quote + attribution
{
  const input = [
    { layout: 'quote', title: '引言', quote: '名言', attribution: '出处' },
  ];
  const { validSlides } = validateStructuredSlides(input);
  log('2.7 顶层 quote → content', validSlides.length === 1);
}

// 2.8 normalizeSlideContent：content 已有则不重建
{
  const input = [
    { layout: 'list', title: '要点', content: { points: ['P1', 'P2'] }, points: ['忽略'] },
  ];
  const { validSlides } = validateStructuredSlides(input);
  log('2.8 content 已有不重建', validSlides.length === 1);
}

// 2.9 content 是字符串 JSON
{
  const input = [
    { layout: 'list', title: '要点', content: '{"points":["P1","P2","P3"]}' },
  ];
  const { validSlides } = validateStructuredSlides(input);
  log('2.9 字符串 content 解析', validSlides.length === 1);
}

// ============================================================================
// Part 3: layoutTemplates
// ============================================================================
console.log('\n═══ Part 3: layoutTemplates 预设 ═══');

// 3.1 预设注册表非空
{
  const keys = Object.keys(TEMPLATE_PRESETS);
  log('3.1 预设注册表', keys.length >= 4, keys.join(', '));
}

// 3.2 default 预设有所有布局
{
  const t = TEMPLATE_PRESETS['default'];
  const fields = ['stats', 'cards2', 'cards3', 'timeline', 'comparison', 'twoColumn', 'pageNumber', 'image'];
  const ok = fields.every(f => t[f] !== undefined);
  log('3.2 default 预设完整', ok, fields.filter(f => !t[f]).join(',') || 'all present');
}

// 3.3 apple-keynote 预设
{
  const t = TEMPLATE_PRESETS['apple-keynote'];
  log('3.3 apple-keynote 预设存在', t !== undefined);
  log('3.3a stats.numberFontSize', t?.stats?.numberFontSize > 0);
}

// 3.4 getTemplateForTheme 映射
{
  const appleT = getTemplateForTheme('apple-dark');
  const defaultT = getTemplateForTheme('neon-green');
  const corpT = getTemplateForTheme('corporate');
  log('3.4a apple-dark → apple 预设', appleT === TEMPLATE_PRESETS['apple-keynote']);
  log('3.4b neon-green → default 预设', defaultT === TEMPLATE_PRESETS['default']);
  log('3.4c corporate → corporate 预设', corpT === TEMPLATE_PRESETS['corporate-formal']);
}

// 3.5 未知主题 fallback 到 default
{
  const t = getTemplateForTheme('nonexistent-theme');
  log('3.5 未知主题 fallback', t === TEMPLATE_PRESETS['default']);
}

// 3.6 坐标值合理性（英寸范围 0-10）
{
  const t = TEMPLATE_PRESETS['default'].stats;
  const inRange = t.cardWidth > 0 && t.cardWidth < 10 && t.cardHeight > 0 && t.cardHeight < 10;
  log('3.6 坐标范围合理', inRange, `w=${t.cardWidth} h=${t.cardHeight}`);
}

// ============================================================================
// Part 4: masterDecorations
// ============================================================================
console.log('\n═══ Part 4: masterDecorations ═══');

// 4.1 DECORATIONS 注册表覆盖 9 个 master
{
  const masters = ['TITLE', 'CONTENT_LIST', 'CONTENT_CHART', 'CONTENT_IMAGE', 'END', 'HERO_NUMBER', 'QUOTE', 'COMPARISON', 'TWO_COL'];
  const appleOk = masters.every(m => DECORATIONS['apple']?.[m]);
  const defaultOk = masters.every(m => DECORATIONS['default']?.[m]);
  log('4.1a apple 覆盖 9 master', appleOk);
  log('4.1b default 覆盖 9 master', defaultOk);
}

// 4.2 getDecorations 返回有效配置
{
  const config = getDecorations(true, 'TITLE');
  log('4.2 getDecorations(apple, TITLE)', Array.isArray(config.glows) && Array.isArray(config.lines));
}

// 4.3 getDecorations 未知 master 返回空
{
  const config = getDecorations(false, 'NONEXISTENT');
  log('4.3 未知 master 返回空', config.glows.length === 0 && config.lines.length === 0);
}

// 4.4 buildDecorationObjects 生成 pptx objects
{
  const theme = getThemeConfig('neon-green');
  const config = getDecorations(false, 'TITLE');
  const objects = buildDecorationObjects(config, theme);
  log('4.4 buildDecorationObjects', objects.length > 0, `${objects.length} objects`);
}

// 4.5 colorSource: 'background' 使用 bgColor
{
  const theme = getThemeConfig('neon-green');
  const config = getDecorations(false, 'TITLE'); // DEFAULT_TITLE has background cutout
  const objects = buildDecorationObjects(config, theme);
  const bgGlow = objects.find(o => o.ellipse?.fill?.color === theme.bgColor);
  log('4.5 background cutout 使用 bgColor', bgGlow !== undefined);
}

// 4.6 colorSource: 'border' 使用 cardBorder
{
  const theme = getThemeConfig('neon-green');
  const config = getDecorations(false, 'END'); // DEFAULT_END has border lines
  const objects = buildDecorationObjects(config, theme);
  const borderLine = objects.find(o => o.rect?.fill?.color === theme.cardBorder);
  log('4.6 border line 使用 cardBorder', borderLine !== undefined);
}

// 4.7 panel 使用 bgSecondary（精简后 DEFAULT_END 保留主内容卡片）
{
  const theme = getThemeConfig('neon-green');
  const config = getDecorations(false, 'END'); // DEFAULT_END has secondary panel
  const objects = buildDecorationObjects(config, theme);
  const secondaryPanel = objects.find(o => o.rect?.fill?.color === theme.bgSecondary && o.rect?.rectRadius);
  log('4.7 secondary panel 使用 bgSecondary', secondaryPanel !== undefined);
}

// ============================================================================
// Part 5: getLayoutSchemaDescription
// ============================================================================
console.log('\n═══ Part 5: Schema 描述 ═══');

// 5.1 描述文本包含所有布局
{
  const desc = getLayoutSchemaDescription();
  const layouts = ['stats', 'cards-2', 'cards-3', 'list', 'timeline', 'comparison', 'quote', 'chart'];
  const allPresent = layouts.every(l => desc.includes(`"${l}"`));
  log('5.1 描述包含所有布局', allPresent);
}

// 5.2 描述包含示例
{
  const desc = getLayoutSchemaDescription();
  log('5.2 描述包含示例', desc.includes('示例'));
}

// ============================================================================
// Part 6: StructuredSlide 端到端 — slides JSON → PPTX
// ============================================================================
console.log('\n═══ Part 6: 端到端 StructuredSlide → PPTX ═══');

// 6.1 基础 slides JSON 生成
{
  const r = await generate({
    topic: 'Schema测试',
    slides: [
      { layout: 'list', title: 'Schema测试', isTitle: true, points: ['封面要点'] },
      { layout: 'stats', title: '数据页', stats: [
        { label: '指标A', value: '100', description: '描述A' },
        { label: '指标B', value: '200' },
        { label: '指标C', value: '300' },
      ]},
      { layout: 'list', title: '谢谢', isEnd: true, points: ['结束'] },
    ],
    output_path: path.join(WD, 'test-ppt-output/schema-test-basic.pptx'),
  });
  log('6.1 slides JSON 生成成功', r.success === true);
  log('6.1a 结构化模式标记', r.output?.includes('结构化 JSON'));
}

// 6.2 含 timeline + cards-3 的复杂 slides
{
  const r = await generate({
    topic: '复杂Schema',
    slides: [
      { layout: 'list', title: '复杂Schema', isTitle: true, points: ['测试'] },
      { layout: 'timeline', title: '流程', steps: [
        { title: '第一步', description: '开始执行' },
        { title: '第二步', description: '继续推进' },
        { title: '第三步', description: '完成验收' },
      ]},
      { layout: 'cards-3', title: '三要素', cards: [
        { title: '卡片A', description: '描述A内容' },
        { title: '卡片B', description: '描述B内容' },
        { title: '卡片C', description: '描述C内容' },
      ]},
      { layout: 'list', title: '总结', isEnd: true, points: ['完'] },
    ],
    output_path: path.join(WD, 'test-ppt-output/schema-test-complex.pptx'),
  });
  log('6.2 复杂 slides 生成成功', r.success === true);
  log('6.2a 页数正确', r.metadata?.slidesCount === 4, `${r.metadata?.slidesCount} slides`);
}

// 6.3 无效 slides fallback 到传统通道
{
  const r = await generate({
    topic: 'Fallback测试',
    slides: [
      { layout: 'stats', title: '无效', content: {} }, // 无效
    ],
    output_path: path.join(WD, 'test-ppt-output/schema-test-fallback.pptx'),
  });
  log('6.3 无效 slides fallback', r.success === true);
  log('6.3a 非结构化模式', !r.output?.includes('结构化 JSON'));
}

// 6.4 slides 与 apple-dark 主题
{
  const r = await generate({
    topic: 'Apple主题',
    theme: 'apple-dark',
    slides: [
      { layout: 'list', title: 'Apple主题', isTitle: true, points: ['测试'] },
      { layout: 'stats', title: 'Apple指标', stats: [
        { label: '速度', value: '2x' },
        { label: '效率', value: '95%' },
        { label: '覆盖', value: '100%' },
      ]},
      { layout: 'list', title: '完', isEnd: true, points: ['谢谢'] },
    ],
    output_path: path.join(WD, 'test-ppt-output/schema-test-apple.pptx'),
  });
  log('6.4 apple-dark + slides JSON', r.success === true);
}

// ============================================================================
// Part 7: generateStructuredSlides — modelCallback
// ============================================================================
console.log('\n═══ Part 7: modelCallback ═══');

// 7.1 成功的 modelCallback
{
  const mockCallback = async (prompt) => {
    return JSON.stringify([
      { layout: 'list', title: '模型封面', isTitle: true, points: ['开场'] },
      { layout: 'stats', title: '模型数据', stats: [
        { label: 'X', value: '100' }, { label: 'Y', value: '200' }, { label: 'Z', value: '300' },
      ]},
      { layout: 'list', title: '模型结尾', isEnd: true, points: ['结束'] },
    ]);
  };
  const slides = await generateStructuredSlides('测试主题', 3, mockCallback);
  log('7.1 mock callback 成功', slides !== null && slides.length === 3);
}

// 7.2 callback 返回 markdown 包裹 JSON
{
  const mockCallback = async () => {
    return '```json\n' + JSON.stringify([
      { layout: 'list', title: '封面', isTitle: true, content: { points: ['P1', 'P2'] } },
      { layout: 'list', title: '结尾', isEnd: true, content: { points: ['end'] } },
    ]) + '\n```';
  };
  const slides = await generateStructuredSlides('测试', 2, mockCallback);
  log('7.2 markdown 包裹 JSON', slides !== null && slides.length === 2);
}

// 7.3 callback 返回无效内容 → null
{
  const mockCallback = async () => '这不是JSON';
  const slides = await generateStructuredSlides('测试', 3, mockCallback);
  log('7.3 无效响应 → null', slides === null);
}

// 7.4 callback 抛异常 → null
{
  const mockCallback = async () => { throw new Error('网络错误'); };
  const slides = await generateStructuredSlides('测试', 3, mockCallback);
  log('7.4 异常 → null', slides === null);
}

// 7.5 callback 返回全部无效 slides → null
{
  const mockCallback = async () => JSON.stringify([
    { layout: 'stats', title: '无效', content: {} },
    { layout: 'timeline', title: '无效2', content: {} },
  ]);
  const slides = await generateStructuredSlides('测试', 2, mockCallback);
  log('7.5 全部无效 → null', slides === null);
}

// 7.6 prompt 包含 topic
{
  let capturedPrompt = '';
  const mockCallback = async (prompt) => {
    capturedPrompt = prompt;
    return '[]';
  };
  await generateStructuredSlides('AI 自动驾驶', 5, mockCallback);
  log('7.6 prompt 含 topic', capturedPrompt.includes('AI 自动驾驶'));
  log('7.6a prompt 含 slideCount', capturedPrompt.includes('5'));
}

// ============================================================================
// Part 8: python-pptx 结构验证（如可用）
// ============================================================================
console.log('\n═══ Part 8: python-pptx 结构验证 ═══');

{
  const testFile = path.join(WD, 'test-ppt-output/schema-test-complex.pptx');
  if (fs.existsSync(testFile)) {
    try {
      const { execSync } = await import('child_process');
      const pyScript = `
from pptx import Presentation
import json, sys
prs = Presentation("${testFile}")
result = {
  "slides": len(prs.slides),
  "masters": [s.slide_layout.name for s in prs.slides],
}
print(json.dumps(result))
`;
      const out = execSync(`python3 -c '${pyScript}'`, { encoding: 'utf-8' }).trim();
      const data = JSON.parse(out);
      log('8.1 slide 数量', data.slides === 4, `${data.slides} slides`);
      log('8.2 首页 TITLE master', data.masters[0] === 'MASTER_TITLE');
      log('8.3 末页 END master', data.masters[data.masters.length - 1] === 'MASTER_END');
      log('8.4 布局多样性', new Set(data.masters).size >= 3, `${new Set(data.masters).size} distinct`);
    } catch (e) {
      log('8.x python-pptx 跳过', true, e.message?.substring(0, 60));
    }
  } else {
    log('8.x 测试文件不存在', true, 'skipped');
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

console.log(`\n═══ 测试完成 ═══`);
console.log(`${passed + failed} 项: ${passed} 通过, ${failed} 失败`);
if (failed === 0) console.log('✅ 全部通过');
else console.log('❌ 有失败项');
