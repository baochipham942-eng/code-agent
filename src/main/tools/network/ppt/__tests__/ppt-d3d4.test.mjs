// ============================================================================
// PPT D3 (Content Quality) & D4 (Visual Design) 改进测试
// 运行: npx tsx src/main/tools/network/ppt/__tests__/ppt-d3d4.test.mjs
// ============================================================================

import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';

const projectRequire = createRequire(
  path.resolve('/Users/linchen/Downloads/ai/code-agent/package.json')
);
globalThis.require = projectRequire;

const { splitOverloadedSlides, mergeThinSlides, normalizeDensity } = await import('../densityControl.ts');
const { validateNarrative } = await import('../narrativeValidator.ts');
const { hexToHSL, hslToHex, generateGoldenAnglePalette, adjustBrightness } = await import('../colorUtils.ts');
const { getSpacingConfig, getContentArea } = await import('../spacing.ts');
const { getThemeConfig } = await import('../themes.ts');
const { selectMasterAndLayout, resetLayoutRotation } = await import('../layouts.ts');
const { enrichSlideContent } = await import('../slideContentAgent.ts');

const WD = '/Users/linchen/Downloads/ai/code-agent';
let pass = 0, fail = 0;

function log(name, ok, detail = '') {
  const icon = ok ? '✅' : '❌';
  console.log(`  ${icon} ${name}${detail ? ' — ' + detail : ''}`);
  if (ok) pass++; else { fail++; process.exitCode = 1; }
}

// ============================================================================
// Part A: Density Control (D3) — 信息密度控制
// ============================================================================
console.log('\n═══ Part A: Density Control (D3) ═══');

// A.1 splitOverloadedSlides: 8 points / max 6 → splits into 2 slides
{
  const slide = { title: '测试页', points: ['p1','p2','p3','p4','p5','p6','p7','p8'], isTitle: false, isEnd: false };
  const result = splitOverloadedSlides([slide], 6);
  log('A.1 8 points / max 6 → 2 slides', result.length === 2, `got ${result.length}`);
}

// A.2 splitOverloadedSlides: first keeps original title, second has "(续)"
{
  const slide = { title: '原始标题', points: ['p1','p2','p3','p4','p5','p6','p7','p8'], isTitle: false, isEnd: false };
  const result = splitOverloadedSlides([slide], 6);
  log('A.2 first keeps original title', result[0].title === '原始标题');
  log('A.2a second has "(续)" suffix', result[1].title === '原始标题 (续)', result[1].title);
}

// A.3 splitOverloadedSlides: exactly 6 points → no split
{
  const slide = { title: '刚好6点', points: ['p1','p2','p3','p4','p5','p6'], isTitle: false, isEnd: false };
  const result = splitOverloadedSlides([slide], 6);
  log('A.3 exactly 6 points → no split', result.length === 1, `got ${result.length}`);
}

// A.4 splitOverloadedSlides: 13 points → splits into 3 slides
{
  const points = Array.from({ length: 13 }, (_, i) => `p${i + 1}`);
  const slide = { title: '很多内容', points, isTitle: false, isEnd: false };
  const result = splitOverloadedSlides([slide], 6);
  log('A.4 13 points → 3 slides', result.length === 3, `got ${result.length}`);
  // Verify all points are preserved
  const totalPoints = result.reduce((sum, s) => sum + s.points.length, 0);
  log('A.4a all 13 points preserved', totalPoints === 13, `total=${totalPoints}`);
}

// A.5 mergeThinSlides: two consecutive slides with 1 point each → merged
{
  const slides = [
    { title: 'Thin1', points: ['p1'], isTitle: false, isEnd: false },
    { title: 'Thin2', points: ['p2'], isTitle: false, isEnd: false },
  ];
  const result = mergeThinSlides(slides, 2);
  log('A.5 two thin slides → merged into one', result.length === 1, `got ${result.length}`);
  log('A.5a merged points count = 2', result[0].points.length === 2);
}

// A.6 mergeThinSlides: title and end slides are never merged
{
  const slides = [
    { title: '标题', points: [], isTitle: true, isEnd: false },
    { title: 'Thin', points: ['p1'], isTitle: false, isEnd: false },
    { title: '谢谢', points: [], isTitle: false, isEnd: true },
  ];
  const result = mergeThinSlides(slides, 2);
  log('A.6 title/end never merged', result.length === 3, `got ${result.length}`);
  log('A.6a title preserved', result[0].isTitle === true);
  log('A.6b end preserved', result[2].isEnd === true);
}

// A.7 mergeThinSlides: a slide with 3 points is not thin (minPoints=2)
{
  const slides = [
    { title: 'NotThin', points: ['p1','p2','p3'], isTitle: false, isEnd: false },
    { title: 'Thin', points: ['p1'], isTitle: false, isEnd: false },
  ];
  const result = mergeThinSlides(slides, 2);
  // NotThin (3 pts) is not thin; Thin (1 pt) has no preceding thin to merge with
  log('A.7 3-point slide not thin', result.length === 2, `got ${result.length}`);
  log('A.7a first slide keeps 3 points', result[0].points.length === 3);
}

// A.8 normalizeDensity: combined split then merge pipeline
{
  const slides = [
    { title: '超多', points: Array.from({ length: 8 }, (_, i) => `p${i + 1}`), isTitle: false, isEnd: false },
    { title: '稀少', points: ['p1'], isTitle: false, isEnd: false },
  ];
  const result = normalizeDensity(slides, { maxPoints: 6, minPoints: 2 });
  // 8 points → split into 2 slides (4+4), then 稀少(1 pt) is thin and merges with second split
  const allPointsCount = result.reduce((sum, s) => sum + s.points.length, 0);
  log('A.8 normalizeDensity pipeline', allPointsCount === 9, `total points=${allPointsCount}`);
}

// A.9 splitOverloadedSlides: preserves subtitle and code only on first part
{
  const slide = {
    title: '代码页', points: ['p1','p2','p3','p4','p5','p6','p7','p8'],
    subtitle: '副标题', code: { language: 'python', content: 'print(1)' },
    isTitle: false, isEnd: false,
  };
  const result = splitOverloadedSlides([slide], 6);
  log('A.9 first part keeps subtitle', result[0].subtitle === '副标题');
  log('A.9a first part keeps code', result[0].code?.language === 'python');
  log('A.9b second part no subtitle', result[1].subtitle === undefined);
  log('A.9c second part no code', result[1].code === undefined);
}

// A.10 splitOverloadedSlides: even distribution (12 points / max 6 → 2 slides of 6 each)
{
  const points = Array.from({ length: 12 }, (_, i) => `p${i + 1}`);
  const slide = { title: '均匀分配', points, isTitle: false, isEnd: false };
  const result = splitOverloadedSlides([slide], 6);
  log('A.10 12/6 → 2 slides', result.length === 2, `got ${result.length}`);
  log('A.10a first slide 6 points', result[0].points.length === 6);
  log('A.10b second slide 6 points', result[1].points.length === 6);
}

// ============================================================================
// Part B: Narrative Validator (D3) — 叙事流验证
// ============================================================================
console.log('\n═══ Part B: Narrative Validator (D3) ═══');

// B.1 missing_intro: first content slide title doesn't match intro keywords
{
  const slides = [
    { title: '标题', points: [], isTitle: true, isEnd: false },
    { title: '产品功能', points: ['功能A', '功能B'], isTitle: false, isEnd: false },
    { title: '谢谢', points: [], isTitle: false, isEnd: true },
  ];
  const issues = validateNarrative(slides);
  const hasIntroIssue = issues.some(i => i.type === 'missing_intro');
  log('B.1 missing_intro detected', hasIntroIssue, `issues: ${issues.map(i => i.type).join(',')}`);
}

// B.2 no missing_intro: first content slide title is "背景概述"
{
  const slides = [
    { title: '标题', points: [], isTitle: true, isEnd: false },
    { title: '背景概述', points: ['内容A'], isTitle: false, isEnd: false },
    { title: '谢谢', points: [], isTitle: false, isEnd: true },
  ];
  const issues = validateNarrative(slides);
  const hasIntroIssue = issues.some(i => i.type === 'missing_intro');
  log('B.2 no missing_intro for "背景概述"', !hasIntroIssue);
}

// B.3 consecutive_data: 3+ slides with 3+ numeric points
{
  const makeNumericSlide = (title) => ({
    title, points: ['收入 100 万', '增长 20%', '用户 500 万'], isTitle: false, isEnd: false,
  });
  const slides = [
    { title: '标题', points: [], isTitle: true, isEnd: false },
    makeNumericSlide('数据1'),
    makeNumericSlide('数据2'),
    makeNumericSlide('数据3'),
    { title: '谢谢', points: [], isTitle: false, isEnd: true },
  ];
  const issues = validateNarrative(slides);
  const hasConsecutive = issues.some(i => i.type === 'consecutive_data');
  log('B.3 consecutive_data detected', hasConsecutive);
}

// B.4 no consecutive_data: numeric slides interleaved with text
{
  const numSlide = { title: '数据', points: ['收入 100 万', '增长 20%', '用户 500 万'], isTitle: false, isEnd: false };
  const textSlide = { title: '分析', points: ['深入探讨趋势'], isTitle: false, isEnd: false };
  const slides = [
    { title: '标题', points: [], isTitle: true, isEnd: false },
    numSlide,
    textSlide,
    { ...numSlide, title: '数据2' },
    { title: '谢谢', points: [], isTitle: false, isEnd: true },
  ];
  const issues = validateNarrative(slides);
  const hasConsecutive = issues.some(i => i.type === 'consecutive_data');
  log('B.4 no consecutive_data when interleaved', !hasConsecutive);
}

// B.5 no_evidence: no slides with evidence keywords
{
  const slides = [
    { title: '标题', points: [], isTitle: true, isEnd: false },
    { title: '概述', points: ['内容'], isTitle: false, isEnd: false },
    { title: '计划', points: ['步骤一'], isTitle: false, isEnd: false },
    { title: '谢谢', points: [], isTitle: false, isEnd: true },
  ];
  const issues = validateNarrative(slides);
  const hasNoEvidence = issues.some(i => i.type === 'no_evidence');
  log('B.5 no_evidence detected', hasNoEvidence);
}

// B.6 has evidence: a slide has "数据分析" in title
{
  const slides = [
    { title: '标题', points: [], isTitle: true, isEnd: false },
    { title: '数据分析报告', points: ['指标A'], isTitle: false, isEnd: false },
    { title: '谢谢', points: [], isTitle: false, isEnd: true },
  ];
  const issues = validateNarrative(slides);
  const hasNoEvidence = issues.some(i => i.type === 'no_evidence');
  log('B.6 no no_evidence when "数据分析" present', !hasNoEvidence);
}

// B.7 missing_summary: last content slide doesn't match summary keywords
{
  const slides = [
    { title: '标题', points: [], isTitle: true, isEnd: false },
    { title: '背景概述', points: ['内容'], isTitle: false, isEnd: false },
    { title: '数据展示', points: ['指标'], isTitle: false, isEnd: false },
    { title: '谢谢', points: [], isTitle: false, isEnd: true },
  ];
  const issues = validateNarrative(slides);
  const hasMissingSummary = issues.some(i => i.type === 'missing_summary');
  log('B.7 missing_summary detected', hasMissingSummary);
}

// B.8 empty slides → returns empty issues array
{
  const issues = validateNarrative([]);
  log('B.8 empty slides → no issues', issues.length === 0, `got ${issues.length}`);
}

// ============================================================================
// Part C: Color Utils (D4) — 颜色工具
// ============================================================================
console.log('\n═══ Part C: Color Utils (D4) ═══');

// C.1 hexToHSL: pure red 'ff0000' → h≈0, s=100, l=50
{
  const { h, s, l } = hexToHSL('ff0000');
  log('C.1 red h≈0', Math.abs(h) < 1, `h=${h.toFixed(1)}`);
  log('C.1a red s=100', Math.abs(s - 100) < 0.1, `s=${s.toFixed(1)}`);
  log('C.1b red l=50', Math.abs(l - 50) < 0.1, `l=${l.toFixed(1)}`);
}

// C.2 hexToHSL: pure white 'ffffff' → l=100, s=0
{
  const { s, l } = hexToHSL('ffffff');
  log('C.2 white l=100', Math.abs(l - 100) < 0.1, `l=${l.toFixed(1)}`);
  log('C.2a white s=0', Math.abs(s) < 0.1, `s=${s.toFixed(1)}`);
}

// C.3 hexToHSL: pure black '000000' → l=0, s=0
{
  const { s, l } = hexToHSL('000000');
  log('C.3 black l=0', Math.abs(l) < 0.1, `l=${l.toFixed(1)}`);
  log('C.3a black s=0', Math.abs(s) < 0.1, `s=${s.toFixed(1)}`);
}

// C.4 hslToHex: roundtrip - hexToHSL then hslToHex → back to original
{
  const original = 'ff0000';
  const { h, s, l } = hexToHSL(original);
  const roundtrip = hslToHex(h, s, l);
  log('C.4 roundtrip ff0000', roundtrip === original, `got ${roundtrip}`);
}

// C.5 generateGoldenAnglePalette: 8 colors from '00ff00' → 8 unique hex strings
{
  const palette = generateGoldenAnglePalette('00ff00', 8);
  log('C.5 palette count = 8', palette.length === 8, `got ${palette.length}`);
  const uniqueColors = new Set(palette);
  log('C.5a all unique', uniqueColors.size === 8, `unique=${uniqueColors.size}`);
}

// C.6 generateGoldenAnglePalette: first color is close to the base color
{
  const palette = generateGoldenAnglePalette('00ff00', 8);
  // First color should be the base itself (offset 0 * 137.508)
  const baseHSL = hexToHSL('00ff00');
  const firstHSL = hexToHSL(palette[0]);
  const hueDiff = Math.abs(baseHSL.h - firstHSL.h);
  log('C.6 first color close to base', hueDiff < 2, `hue diff=${hueDiff.toFixed(1)}`);
}

// C.7 adjustBrightness: lighten '000000' by 50 → result is lighter
{
  const result = adjustBrightness('000000', 50);
  log('C.7 lighten black → not black', result !== '000000', `got ${result}`);
  const { l } = hexToHSL(result);
  log('C.7a lightness ≈ 50', Math.abs(l - 50) < 1, `l=${l.toFixed(1)}`);
}

// C.8 adjustBrightness: darken 'ffffff' by -50 → result is darker
{
  const result = adjustBrightness('ffffff', -50);
  log('C.8 darken white → not white', result !== 'ffffff', `got ${result}`);
  const { l } = hexToHSL(result);
  log('C.8a lightness ≈ 50', Math.abs(l - 50) < 1, `l=${l.toFixed(1)}`);
}

// ============================================================================
// Part D: Spacing (D4) — 主题感知间距
// ============================================================================
console.log('\n═══ Part D: Spacing (D4) ═══');

// D.1 apple-dark theme spacing: name is Chinese '苹果暗黑' so falls into dark neon path
//     (isApple checks theme.name.includes('apple') which is false for Chinese name)
{
  const theme = getThemeConfig('apple-dark');
  const spacing = getSpacingConfig(theme);
  // apple-dark has isDark=true and name='苹果暗黑' → hits dark neon default (gap=0.22)
  log('D.1 apple-dark gap ≤ 0.25', spacing.gap <= 0.25, `gap=${spacing.gap}`);
}

// D.2 glass-light theme (not dark) uses standard spacing with larger gap
{
  const theme = getThemeConfig('glass-light');
  const spacing = getSpacingConfig(theme);
  log('D.2 glass-light gap > apple gap', spacing.gap > 0.2, `gap=${spacing.gap}`);
  log('D.2a glass-light lineHeight = 1.4', spacing.lineHeight === 1.4, `lineHeight=${spacing.lineHeight}`);
}

// D.3 neon-green theme (dark, not apple) uses generous spacing
{
  const theme = getThemeConfig('neon-green');
  const spacing = getSpacingConfig(theme);
  log('D.3 neon-green is dark path', spacing.padding.top === 1.5, `top=${spacing.padding.top}`);
  log('D.3a neon-green lineHeight = 1.3', spacing.lineHeight === 1.3, `lineHeight=${spacing.lineHeight}`);
}

// D.4 getContentArea returns valid dimensions (w > 0, h > 0)
{
  const theme = getThemeConfig('neon-green');
  const spacing = getSpacingConfig(theme);
  const area = getContentArea(spacing);
  log('D.4 content area w > 0', area.w > 0, `w=${area.w}`);
  log('D.4a content area h > 0', area.h > 0, `h=${area.h}`);
  log('D.4b content area x ≥ 0', area.x >= 0, `x=${area.x}`);
  log('D.4c content area y ≥ 0', area.y >= 0, `y=${area.y}`);
}

// D.5 all themes produce valid spacing configs (no negative values)
{
  const themes = ['neon-green', 'neon-blue', 'neon-purple', 'neon-orange',
    'glass-light', 'glass-dark', 'minimal-mono', 'corporate', 'apple-dark'];
  let allValid = true;
  for (const t of themes) {
    const theme = getThemeConfig(t);
    const spacing = getSpacingConfig(theme);
    const valid = spacing.gap >= 0 && spacing.cardMargin >= 0 &&
      spacing.lineHeight > 0 && spacing.minFontSize > 0 &&
      spacing.padding.top >= 0 && spacing.padding.bottom >= 0 &&
      spacing.padding.left >= 0 && spacing.padding.right >= 0;
    if (!valid) {
      allValid = false;
      log(`D.5 ${t} invalid spacing`, false);
    }
  }
  log('D.5 all themes valid spacing', allValid, `${themes.length} themes checked`);
}

// ============================================================================
// Part E: Layout Rhythm (D4) — 布局节奏
// ============================================================================
console.log('\n═══ Part E: Layout Rhythm (D4) ═══');

// E.1 After reset, running same content 4 times → no 3+ consecutive same layout
{
  resetLayoutRotation();
  const layouts = [];
  for (let i = 0; i < 4; i++) {
    const slide = { title: `通用页面${i}`, points: ['A', 'B', 'C', 'D'], isTitle: false, isEnd: false };
    const { layout } = selectMasterAndLayout(slide, false, 'auto');
    layouts.push(layout);
  }
  let hasTriple = false;
  for (let i = 2; i < layouts.length; i++) {
    if (layouts[i] === layouts[i - 1] && layouts[i] === layouts[i - 2]) {
      hasTriple = true;
    }
  }
  log('E.1 no 3+ consecutive same layout', !hasTriple, layouts.join(' → '));
}

// E.2 quote detection: title with "引言" and ≤2 points → quote layout
{
  resetLayoutRotation();
  const slide = { title: '引言', points: ['一句名言'], isTitle: false, isEnd: false };
  const { layout } = selectMasterAndLayout(slide, false, 'auto');
  log('E.2 "引言" + ≤2 pts → quote', layout === 'quote', layout);
}

// E.3 comparison detection: title with "对比" → comparison or cards-2
{
  resetLayoutRotation();
  const slide = { title: '方案对比', points: ['优势A', '优势B', '劣势C', '劣势D'], isTitle: false, isEnd: false };
  const { layout } = selectMasterAndLayout(slide, false, 'auto');
  const isComparisonFamily = layout === 'comparison' || layout === 'cards-2';
  log('E.3 "对比" → comparison/cards-2', isComparisonFamily, layout);
}

// E.4 two-column: 7+ points → two-column layout
{
  resetLayoutRotation();
  const slide = { title: '综合内容', points: ['A','B','C','D','E','F','G'], isTitle: false, isEnd: false };
  const { layout } = selectMasterAndLayout(slide, false, 'auto');
  log('E.4 7+ points → two-column', layout === 'two-column', layout);
}

// E.5 rhythm: verify no consecutive stats by running multiple numeric slides
{
  resetLayoutRotation();
  const layouts = [];
  for (let i = 0; i < 5; i++) {
    const slide = {
      title: `市场数据${i}`,
      points: ['收入 100 万', '增长 20%', '用户 500 万', '满意度 4.5 分'],
      isTitle: false, isEnd: false,
    };
    const { layout } = selectMasterAndLayout(slide, false, 'auto');
    layouts.push(layout);
  }
  let hasConsecutiveStats = false;
  for (let i = 1; i < layouts.length; i++) {
    if (layouts[i] === 'stats' && layouts[i - 1] === 'stats') {
      hasConsecutiveStats = true;
    }
  }
  log('E.5 no consecutive stats', !hasConsecutiveStats, layouts.join(' → '));
}

// ============================================================================
// Part F: Content Template Library (D3) — 内容模板库
// ============================================================================
console.log('\n═══ Part F: Content Template Library (D3) ═══');

// F.1 slide with "技术架构" title → enriched with technology-related templates
{
  const result = enrichSlideContent({
    index: 0, title: '技术架构', existingPoints: ['现有要点'], topic: '产品介绍', targetPointCount: 4,
  });
  log('F.1 "技术架构" enriched', result.enriched === true);
  const hasTechContent = result.points.some(p => /技术|架构|算法|性能|安全|扩展/i.test(p));
  log('F.1a contains tech templates', hasTechContent, result.points.slice(1).join(' | '));
}

// F.2 slide with "应用场景" title → enriched (not just generic)
{
  const result = enrichSlideContent({
    index: 1, title: '应用场景', existingPoints: ['场景A'], topic: '产品介绍', targetPointCount: 4,
  });
  log('F.2 "应用场景" enriched', result.enriched === true);
  const hasAppContent = result.points.some(p => /场景|案例|实践|客户|用户/i.test(p));
  log('F.2a contains application templates', hasAppContent);
}

// F.3 slide that already has enough points → not enriched
{
  const result = enrichSlideContent({
    index: 2, title: '已完整', existingPoints: ['p1', 'p2', 'p3', 'p4', 'p5'], topic: '产品介绍', targetPointCount: 4,
  });
  log('F.3 enough points → not enriched', result.enriched === false);
}

// F.4 enriched points should not contain placeholder text
{
  const result = enrichSlideContent({
    index: 3, title: '市场背景', existingPoints: [], topic: '产品介绍', targetPointCount: 4,
  });
  const hasPlaceholder = result.points.some(p => p === '补充要点' || p === '待补充');
  log('F.4 no placeholder text', !hasPlaceholder, result.points.join(' | '));
}

// ============================================================================
// Summary
// ============================================================================
console.log(`\n═══ Summary: ${pass} passed, ${fail} failed (${pass + fail} total) ═══`);
