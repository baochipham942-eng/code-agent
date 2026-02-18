// ============================================================================
// Design Mode — 脚手架 + 设计系统
// ============================================================================
// 将 ThemeConfig 转换为 DS 常量，拼装完整可执行脚本。
// LLM 生成的 slide 代码插入 scaffold 中间，由 npx tsx 执行。
// ============================================================================

import type { ThemeConfig } from './types';
import { generateGoldenAnglePalette } from './colorUtils';
import { DESIGN_CANVAS } from './constants';

/**
 * 将 ThemeConfig 转换为设计系统常量字符串（注入脚本）
 */
export function themeToDesignSystem(theme: ThemeConfig): string {
  // accent2~4 通过黄金角旋转自动生成
  const palette = generateGoldenAnglePalette(theme.accent, 4);
  const accent2 = palette[1];
  const accent3 = palette[2];
  const accent4 = palette[3];

  const fontTitle = theme.fontTitleCN || theme.fontTitle;
  const fontBody = theme.fontBodyCN || theme.fontBody;

  return `// ── Design System ──
const DS = {
  bg:       '${theme.bgColor}',
  bgCard:   '${theme.bgSecondary}',
  text:     '${theme.textPrimary}',
  textMuted:'${theme.textSecondary}',
  accent:   '${theme.accent}',
  accent2:  '${accent2}',
  accent3:  '${accent3}',
  accent4:  '${accent4}',
  glow:     '${theme.accentGlow}',
  border:   '${theme.cardBorder}',
  isDark:   ${theme.isDark},
};

const F = {
  title: '${fontTitle}',
  body:  '${fontBody}',
  code:  '${theme.fontCode}',
};

// ── Canvas Constants ──
const W = ${DESIGN_CANVAS.WIDTH};
const H = ${DESIGN_CANVAS.HEIGHT};
const MX = ${DESIGN_CANVAS.MARGIN_X};
const MY = ${DESIGN_CANVAS.MARGIN_Y};
const CW = W - MX * 2;   // content width = 11.93
const CH = H - MY * 2;   // content height = 6.5
`;
}

/**
 * 构建完整可执行脚本
 *
 * @param theme - 主题配置
 * @param outputPath - PPTX 输出路径
 * @param projectRoot - 项目根目录（用于 resolve pptxgenjs）
 * @param slideCode - LLM 生成的 slide 代码段
 */
export function buildScaffold(
  theme: ThemeConfig,
  outputPath: string,
  projectRoot: string,
  slideCode: string,
): string {
  const ds = themeToDesignSystem(theme);
  const escapedOutput = outputPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const escapedRoot = projectRoot.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  return `// ============================================================================
// PPT Design Mode — Auto-generated scaffold
// ============================================================================
import { createRequire } from 'module';
const require = createRequire('${escapedRoot}/package.json');
const PptxGenJS = require('pptxgenjs');

${ds}
// ── pptxgenjs instance ──
const pptx = new PptxGenJS();
pptx.layout = 'LAYOUT_WIDE';
pptx.author = 'Code Agent (Design Mode)';

// ── Color Utilities ──

/** 清洗颜色值：去 #、截断到 6 位，拦截 'none'/'transparent' 等无效值 */
function hex6(c: string): string {
  if (!c || c === 'none' || c === 'transparent' || c === 'inherit') return hex6(DS.text);
  const h = c.replace(/^#/, '').substring(0, 6);
  return /^[0-9a-fA-F]{6}$/.test(h) ? h : hex6(DS.text);
}

/** 混合颜色与背景色，模拟透明度效果（LLM 用此替代字符串拼接 alpha） */
function dimColor(fg: string, opacity: number = 0.2): string {
  const f = hex6(fg);
  const b = hex6(DS.bg);
  const mix = (fc: number, bc: number) => Math.round(fc * opacity + bc * (1 - opacity));
  const r = mix(parseInt(f.substring(0, 2), 16), parseInt(b.substring(0, 2), 16));
  const g = mix(parseInt(f.substring(2, 4), 16), parseInt(b.substring(2, 4), 16));
  const bl = mix(parseInt(f.substring(4, 6), 16), parseInt(b.substring(4, 6), 16));
  return r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + bl.toString(16).padStart(2, '0');
}

// ── Helper Functions ──

/** 添加全页背景 */
function addBg(s: any, color?: string) {
  s.background = { fill: hex6(color || DS.bg) };
}

/** 添加页面标题（y=0.4, 左对齐） */
function addTitle(s: any, text: string, opts?: Record<string, any>) {
  s.addText(text, {
    x: MX, y: 0.4, w: CW, h: 0.6,
    fontSize: 28, fontFace: F.title,
    color: hex6(DS.text), bold: true,
    ...opts,
  });
}

/** 添加页脚文字（底部居中） */
function addFooter(s: any, text: string) {
  s.addText(text, {
    x: MX, y: H - 0.5, w: CW, h: 0.3,
    fontSize: 9, fontFace: F.body,
    color: hex6(DS.textMuted), align: 'center',
  });
}

/** 添加页码（右下角） */
function addPageNum(s: any, num: number, total: number) {
  s.addText(\`\${num} / \${total}\`, {
    x: W - 1.2, y: H - 0.5, w: 0.8, h: 0.3,
    fontSize: 9, fontFace: F.body,
    color: hex6(DS.textMuted), align: 'right',
  });
}

/** 添加圆角卡片 */
function addCard(
  s: any,
  x: number, y: number, w: number, h: number,
  opts?: { fill?: string; line?: any; radius?: number },
) {
  // 防御：line 可能是字符串（LLM 常见错误）
  let lineObj = opts?.line || { color: hex6(DS.border), width: 0.5 };
  if (typeof lineObj === 'string') lineObj = { color: hex6(lineObj), width: 0.5 };
  else if (lineObj.color) lineObj = { ...lineObj, color: hex6(lineObj.color) };

  s.addShape('roundRect' as any, {
    x, y, w, h,
    fill: { color: hex6(opts?.fill || DS.bgCard) },
    line: lineObj,
    rectRadius: opts?.radius ?? 0.15,
  });
}

// ── Advanced Layout Helpers ──

/** Hub-Spoke 架构图：中心圆 + 外围节点 + 射线连线 */
function addHubSpoke(
  s: any,
  centerLabel: string,
  nodes: Array<{ label: string; desc?: string; color?: string }>,
  opts?: { centerColor?: string; y?: number },
) {
  const topY = opts?.y ?? 2.6;
  const cColor = hex6(opts?.centerColor || DS.accent);
  const R = 1.1;
  const hubX = W / 2;
  const hubY = topY + R;

  // 中心圆
  s.addShape('ellipse' as any, {
    x: hubX - R, y: topY, w: R * 2, h: R * 2,
    fill: { color: cColor }, line: { color: cColor, width: 2 },
  });
  s.addText(centerLabel, {
    x: hubX - R + 0.2, y: topY + R * 0.4, w: R * 2 - 0.4, h: R * 1.2,
    fontSize: 18, fontFace: F.title, color: 'FFFFFF', bold: true, align: 'center',
  });

  // 外围节点：左右各半
  const nodeW = 2.6, nodeH = 0.9;
  const leftX = MX;
  const rightX = W - MX - nodeW;
  const halfCount = Math.ceil(nodes.length / 2);
  const nodeSpacing = Math.min(1.4, 4.0 / Math.max(halfCount, 1));

  nodes.forEach((n, i) => {
    const isLeft = i < halfCount;
    const localIdx = isLeft ? i : i - halfCount;
    const localCount = isLeft ? halfCount : nodes.length - halfCount;
    const nx = isLeft ? leftX : rightX;
    const ny = hubY + (localIdx - (localCount - 1) / 2) * nodeSpacing - nodeH / 2;
    const nColor = hex6(n.color || [DS.accent, DS.accent2, DS.accent3, DS.accent4][i % 4]);

    // 节点卡片
    addCard(s, nx, ny, nodeW, nodeH, { line: { color: nColor, width: 1.5 } });
    s.addText(n.label, {
      x: nx + 0.3, y: ny + (n.desc ? 0.08 : 0.15), w: nodeW - 0.6, h: 0.4,
      fontSize: 14, fontFace: F.body, color: nColor, bold: true, align: 'center',
    });
    if (n.desc) {
      s.addText(n.desc, {
        x: nx + 0.3, y: ny + 0.45, w: nodeW - 0.6, h: 0.35,
        fontSize: 11, fontFace: F.body, color: hex6(DS.textMuted), align: 'center',
      });
    }

    // ── 水平连线（节点色 + 端点装饰） ──
    const lineY = ny + nodeH / 2;
    const lineColor = dimColor(nColor, 0.4);
    if (isLeft) {
      const x1 = nx + nodeW;
      const x2 = hubX - R;
      s.addShape('line' as any, {
        x: x1, y: lineY, w: x2 - x1, h: 0,
        line: { color: lineColor, width: 1.5 },
      });
      s.addShape('ellipse' as any, {
        x: x2 - 0.08, y: lineY - 0.08, w: 0.16, h: 0.16,
        fill: { color: nColor },
      });
    } else {
      const x1 = hubX + R;
      const x2 = nx;
      s.addShape('line' as any, {
        x: x1, y: lineY, w: x2 - x1, h: 0,
        line: { color: lineColor, width: 1.5 },
      });
      s.addShape('ellipse' as any, {
        x: x1 - 0.08, y: lineY - 0.08, w: 0.16, h: 0.16,
        fill: { color: nColor },
      });
    }
  });
}

/** 时间轴：水平线 + 节点 + 标签（所有标签在上方，描述在下方，绝不重叠） */
function addTimeline(
  s: any,
  milestones: Array<{ year: string; label: string; desc?: string; color?: string }>,
  opts?: { lineY?: number },
) {
  const lineY = opts?.lineY ?? 3.8;
  const marginX = MX + 0.8;
  const lineW = W - marginX * 2;

  // 水平主线
  s.addShape('line' as any, {
    x: marginX, y: lineY, w: lineW, h: 0,
    line: { color: hex6(DS.border), width: 2 },
  });

  const step = milestones.length > 1 ? lineW / (milestones.length - 1) : 0;
  milestones.forEach((m, i) => {
    const dotCx = marginX + i * step;
    const mColor = hex6(m.color || [DS.accent, DS.accent2, DS.accent3, DS.accent4][i % 4]);

    // 节点圆点
    s.addShape('ellipse' as any, {
      x: dotCx - 0.15, y: lineY - 0.15, w: 0.3, h: 0.3,
      fill: { color: mColor },
    });

    // 垂直短线（圆点到标签区）
    s.addShape('line' as any, {
      x: dotCx, y: lineY - 0.55, w: 0, h: 0.4,
      line: { color: mColor, width: 1 },
    });

    const labelW = Math.min(step * 0.9, 2.2);
    const labelX = dotCx - labelW / 2;

    // 上方：标签（lineY - 1.4）
    s.addText(m.label, {
      x: labelX, y: lineY - 1.5, w: labelW, h: 0.4,
      fontSize: 13, fontFace: F.body, color: hex6(DS.text), align: 'center',
    });
    // 上方：年份（lineY - 1.0）
    s.addText(m.year, {
      x: labelX, y: lineY - 1.0, w: labelW, h: 0.35,
      fontSize: 16, fontFace: F.title, color: mColor, bold: true, align: 'center',
    });
    // 下方：描述（lineY + 0.4）
    if (m.desc) {
      s.addText(m.desc, {
        x: labelX, y: lineY + 0.4, w: labelW, h: 0.5,
        fontSize: 11, fontFace: F.body, color: hex6(DS.textMuted), align: 'center',
      });
    }
  });
}

// ============================================================================
// Slide Code (LLM Generated)
// ============================================================================

${slideCode}

// ============================================================================
// Main — Write file and exit
// ============================================================================

async function main() {
  await pptx.writeFile({ fileName: '${escapedOutput}' });
  process.exit(0);
}

main().catch((err: any) => {
  console.error('PPT generation failed:', err.message || err);
  process.exit(1);
});
`;
}
