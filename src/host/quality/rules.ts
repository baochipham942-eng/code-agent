/**
 * 设计质量规则注册表。
 *
 * 每条规则是源码文本上的纯函数，返回原始命中（行 + 片段，可选的
 * per-hit 文案覆盖）。`detect.ts` 里的门面负责附加规则的
 * id/category/severity，按严格度 + 忽略列表过滤、去重、截断。规则移植
 * 自公开的 impeccable（Apache-2.0）design-lint 启发式——仅算法，命名与
 * 中文文案为本项目自有。
 *
 * 因为运行时无 DOM，每条规则都工作在原始源码上：CSS 声明、Tailwind
 * 工具类、标签。规则偏好精度而非召回，让发现可信。
 */

import {
  describeColor,
  extractColorLiterals,
  isPurpleOrBlueHue,
  type ColorInfo,
} from './color';
import type {
  DesignContext,
  DesignFindingSeverity,
  DesignRuleCategory,
  DesignStrictness,
} from './types';

export type RuleContext = {
  source: string;
  lines: readonly string[];
  /** 小写、无点的文件扩展名（如 `tsx`），无则为 ''。 */
  ext: string;
  designContext?: DesignContext;
};

export type RuleHit = {
  line: number;
  snippet: string;
  /** 覆盖该命中默认文案。 */
  message?: string;
};

export type DesignRule = {
  id: string;
  category: DesignRuleCategory;
  severity: DesignFindingSeverity;
  minStrictness: DesignStrictness;
  title: string;
  /** 默认中文文案；命中可覆盖。 */
  message: string;
  run: (ctx: RuleContext) => RuleHit[];
};

const MARKUP_EXTS = new Set(['html', 'htm', 'xhtml', 'svg', 'vue', 'svelte', 'astro']);
// 组件片段多用 Tailwind `animate-*`（配 `motion-reduce:` 变体）做动画，
// reduced-motion 兜底放在全局 CSS，故 reduced-motion 规则对它们收窄——
// 见 missingReducedMotion。
const COMPONENT_EXTS = new Set(['jsx', 'tsx', 'vue', 'svelte', 'astro']);
const GENERIC_FONTS = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  '-apple-system',
  'blinkmacsystemfont',
  'inherit',
  'cursive',
  'fantasy',
]);
const CHROMATIC_TW_FAMILIES =
  'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';

function snippetOf(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > 140 ? `${trimmed.slice(0, 137)}…` : trimmed;
}

/**
 * 一种温暖、明亮、近中性的颜色——米/沙/纸色 AI 默认族。HSL 饱和度在
 * 亮度趋近白时会虚高，故对 RGB 推导的颜色改用原始通道极差（与亮度无
 * 关）加暖色排序（r ≥ g ≥ b）判断。OKLCH 路径本就带低 chroma。
 */
function isWarmLightNeutral(color: ColorInfo): boolean {
  if (color.lightness <= 0.88) return false;
  if (color.hue == null || color.hue < 25 || color.hue > 105) return false;
  if (color.rgb) {
    const { r, g, b } = color.rgb;
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    return spread > 3 && spread < 60 && r >= g && g >= b;
  }
  return color.saturation > 0.01 && color.saturation < 0.22;
}

/** 在不嵌套于括号内的逗号处拆分一个 CSS 值。 */
function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** 逐行跑正则，每个匹配产出一条命中。 */
function eachLineMatch(
  ctx: RuleContext,
  re: RegExp,
  predicate?: (m: RegExpExecArray, line: string) => boolean,
  messageFor?: (m: RegExpExecArray) => string,
): RuleHit[] {
  const hits: RuleHit[] = [];
  for (let i = 0; i < ctx.lines.length; i++) {
    const line = ctx.lines[i];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (!predicate || predicate(m, line)) {
        const hit: RuleHit = { line: i + 1, snippet: snippetOf(line) };
        if (messageFor) hit.message = messageFor(m);
        hits.push(hit);
      }
      if (!re.global) break;
    }
  }
  return hits;
}

// ── slop：无可辩驳的 AI 痕迹 ───────────────────────────────────────────────

const purpleBlueGradient: DesignRule = {
  id: 'slop-purple-blue-gradient',
  category: 'slop',
  severity: 'warning',
  minStrictness: 'relaxed',
  title: '紫→蓝渐变',
  message:
    '紫→蓝（violet/indigo→blue）渐变是最典型的 AI 生成痕迹。换一个有品牌依据的配色方向，或用单色。',
  run: (ctx) => {
    const hits: RuleHit[] = [];
    // Tailwind：渐变方向工具类 + violet→blue 色带的 from-/to-。
    const twGradient =
      /\b(?:bg-gradient-to-[a-z]{1,2}|bg-linear-to-[a-z]{1,2}|bg-\[(?:linear|radial|conic)-gradient)/;
    const twFrom = /\bfrom-(?:violet|purple|fuchsia|indigo|blue)-\d{2,3}\b/;
    const twTo = /\bto-(?:violet|purple|fuchsia|indigo|blue|sky|cyan)-\d{2,3}\b/;
    for (let i = 0; i < ctx.lines.length; i++) {
      const line = ctx.lines[i];
      if (twGradient.test(line) && twFrom.test(line) && twTo.test(line)) {
        hits.push({ line: i + 1, snippet: snippetOf(line) });
        continue;
      }
      // CSS：色相停靠点全为 violet/blue 的渐变。无彩色停靠点（白/黑/灰，
      // hue == null）被忽略，故经典的 violet→blue→white hero 渐变仍能命中。
      const grad = /(?:linear|radial|conic)-gradient\(([^;]*?)\)/i.exec(line);
      if (grad) {
        const chromatic = extractColorLiterals(grad[1])
          .map(describeColor)
          .filter((c): c is ColorInfo => c?.hue != null);
        if (chromatic.length >= 2 && chromatic.every((c) => isPurpleOrBlueHue(c.hue))) {
          hits.push({ line: i + 1, snippet: snippetOf(line) });
        }
      }
    }
    return hits;
  },
};

const bounceEasing: DesignRule = {
  id: 'slop-bounce-elastic-easing',
  category: 'slop',
  severity: 'warning',
  minStrictness: 'relaxed',
  title: '弹跳/橡皮筋缓动',
  message:
    '弹跳/橡皮筋缓动（cubic-bezier 控制点越界 [0,1]）显得过时。改用 ease-out 指数曲线（quart/quint/expo）。',
  run: (ctx) =>
    eachLineMatch(
      ctx,
      /cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/gi,
      (m) => {
        const y1 = parseFloat(m[2]);
        const y2 = parseFloat(m[4]);
        return y1 < -0.02 || y1 > 1.02 || y2 < -0.02 || y2 > 1.02;
      },
    ),
};

const creamDefaultBg: DesignRule = {
  id: 'slop-cream-default-bg',
  category: 'slop',
  severity: 'warning',
  minStrictness: 'standard',
  title: '米/沙/纸色背景',
  message:
    '米/沙/纸/象牙色背景是当下的 AI 默认底色。用品牌色、纯中性色（chroma 0），或明显属于品牌的中调色。',
  run: (ctx) => {
    const hits: RuleHit[] = [];
    // 米色系 token 名，捕获其声明值——仍校验该值确为暖色浅中性，
    // 故 `--vanilla: #f00` 不会被误报。
    const tokenDecl =
      /--(?:paper|cream|sand|bone|linen|parchment|wheat|biscuit|ivory|flour|eggshell|oat|almond|vanilla)\b\s*:\s*([^;{]+)/i;
    const bgDecl = /background(?:-color)?\s*:\s*([^;{]+)/i;
    for (let i = 0; i < ctx.lines.length; i++) {
      const line = ctx.lines[i];
      const token = tokenDecl.exec(line);
      if (token) {
        const color = extractColorLiterals(token[1]).map(describeColor).find(Boolean);
        if (color && isWarmLightNeutral(color)) {
          hits.push({ line: i + 1, snippet: snippetOf(line) });
        }
        continue;
      }
      const bg = bgDecl.exec(line);
      if (bg) {
        const color = extractColorLiterals(bg[1]).map(describeColor).find(Boolean);
        if (color && isWarmLightNeutral(color)) {
          hits.push({ line: i + 1, snippet: snippetOf(line) });
        }
      }
    }
    return hits;
  },
};

const sideTabBorder: DesignRule = {
  id: 'slop-side-tab-border',
  category: 'slop',
  severity: 'warning',
  minStrictness: 'standard',
  title: '侧边强调条',
  message:
    '单侧彩色粗边框 + 圆角是典型的「侧边强调条」AI 痕迹。改用整体背景/底色变化或更克制的指示。',
  run: (ctx) => {
    const sideBorder = /\bborder-(?:l|r|t|b|s|e)-(?:2|4|8)\b/;
    const rounded = /\brounded(?:-|\b)/;
    const colored = new RegExp(`\\bborder-(?:${CHROMATIC_TW_FAMILIES})-\\d{2,3}\\b`);
    return ctx.lines.reduce<RuleHit[]>((acc, line, i) => {
      if (sideBorder.test(line) && rounded.test(line) && colored.test(line)) {
        acc.push({ line: i + 1, snippet: snippetOf(line) });
      }
      return acc;
    }, []);
  },
};

const gradientText: DesignRule = {
  id: 'slop-gradient-text',
  category: 'slop',
  severity: 'advisory',
  minStrictness: 'standard',
  title: '渐变文字',
  message: '渐变文字（背景裁剪到文字）被过度使用且常有可读性/对比问题。仅在真正增益时保留。',
  run: (ctx) =>
    eachLineMatch(ctx, /\bbg-clip-text\b|(?:-webkit-)?background-clip\s*:\s*text\b/gi),
};

const grayTextOnColor: DesignRule = {
  id: 'slop-gray-text-on-color',
  category: 'slop',
  severity: 'advisory',
  minStrictness: 'strict',
  title: '彩色底上的灰字',
  message:
    '彩色背景上用灰字会发灰发脏。用背景同色系的更深色，或文字色的透明度，而不是中性灰。',
  run: (ctx) => {
    const grayText = /\btext-(?:gray|slate|zinc|neutral|stone)-\d{2,3}\b/;
    const colorBg = new RegExp(`\\bbg-(?:${CHROMATIC_TW_FAMILIES})-\\d{2,3}\\b`);
    return ctx.lines.reduce<RuleHit[]>((acc, line, i) => {
      if (grayText.test(line) && colorBg.test(line)) {
        acc.push({ line: i + 1, snippet: snippetOf(line) });
      }
      return acc;
    }, []);
  },
};

const darkColoredGlow: DesignRule = {
  id: 'slop-dark-colored-glow',
  category: 'slop',
  severity: 'advisory',
  minStrictness: 'strict',
  title: '彩色辉光',
  message:
    '彩色 box-shadow 辉光是常见的暗色 AI 痕迹。用中性阴影表达层级，把发光留给真正需要的元素。',
  run: (ctx) => {
    const hits: RuleHit[] = [];
    const decl = /box-shadow\s*:\s*([^;{]+)/gi;
    for (let i = 0; i < ctx.lines.length; i++) {
      const line = ctx.lines[i];
      decl.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = decl.exec(line)) !== null) {
        // box-shadow 是 `[inset] offset-x offset-y [blur] [spread] color`，可有
        // 多个逗号分隔的层。blur 半径是第 3 个长度——别把大 offset 误当辉光。
        for (const layer of splitTopLevelCommas(m[1])) {
          const chromatic = extractColorLiterals(layer).some((c) => {
            const info = describeColor(c);
            return info != null && info.saturation > 0.35;
          });
          if (!chromatic) continue;
          // 剥掉颜色只留几何数字（offset/blur/spread，可能是无单位 `0` 或
          // px/rem/em）。blur 是第 3 个长度。
          const geometry = layer
            .replace(/#[0-9a-f]{3,8}\b/gi, ' ')
            .replace(/(?:rgba?|hsla?|oklch)\([^)]*\)/gi, ' ');
          const lengths = [...geometry.matchAll(/-?\d+(?:\.\d+)?(?:px|rem|em)?/g)]
            .map((x) => parseFloat(x[0]))
            .filter((n) => !Number.isNaN(n));
          const blur = lengths.length >= 3 ? lengths[2] : 0;
          if (blur >= 8) {
            hits.push({ line: i + 1, snippet: snippetOf(line) });
            break;
          }
        }
      }
    }
    return hits;
  },
};

const grayImagePlaceholder: DesignRule = {
  id: 'slop-gray-image-placeholder',
  category: 'slop',
  severity: 'warning',
  minStrictness: 'relaxed',
  title: '灰色图片占位框',
  message:
    '用灰色空框或占位图床（via.placeholder/dummyimage…）充当图片是典型 AI 痕迹。' +
    '改用真实占位图 `https://picsum.photos/seed/{desc}/{w}/{h}`，并写贴切的 alt。',
  run: (ctx) => {
    const hits: RuleHit[] = [];
    // 占位图床（只为产灰/假图而存在，命中即可信）。
    const placeholderHost =
      /via\.placeholder\.com|placehold\.co|placeholder\.pics|dummyimage\.com|placekitten\.com|placeimg\.com|fakeimg\.pl|baconmockup\.com/i;
    // 灰底（Tailwind 浅灰族）。
    const grayTw = /\bbg-(?:gray|slate|zinc|neutral|stone)-(?:100|200|300|400)\b/;
    // 图片语义尺寸：纵横比工具类 / CSS aspect-ratio——「灰底 + 图片比例」强信号。
    const aspect = /\baspect-(?:\[|video\b|square\b)|aspect-ratio\s*:/;
    // 行内若已是真实图片源则不算灰框（含 picsum 真图、<img>、CSS 图片）。
    const realImage = /<img\b|background-image|url\(|picsum\.photos/i;
    const bgDecl = /background(?:-color)?\s*:\s*([^;{]+)/i;
    for (let i = 0; i < ctx.lines.length; i++) {
      const line = ctx.lines[i];
      if (placeholderHost.test(line)) {
        hits.push({ line: i + 1, snippet: snippetOf(line) });
        continue;
      }
      if (realImage.test(line)) continue;
      let grayFill = grayTw.test(line);
      if (!grayFill) {
        const bg = bgDecl.exec(line);
        if (bg) {
          grayFill = extractColorLiterals(bg[1])
            .map(describeColor)
            .some(
              (c): c is ColorInfo =>
                c != null &&
                (c.hue == null || c.saturation < 0.18) &&
                c.lightness >= 0.45 &&
                c.lightness <= 0.98,
            );
        }
      }
      if (grayFill && aspect.test(line)) {
        hits.push({ line: i + 1, snippet: snippetOf(line) });
      }
    }
    return hits;
  },
};

// ── quality：通用品味 ───────────────────────────────────────────────────────

const overusedFont: DesignRule = {
  id: 'quality-overused-font',
  category: 'quality',
  severity: 'warning',
  minStrictness: 'standard',
  title: '被滥用的字体',
  message:
    'Inter / Arial / Roboto / Helvetica 等是被滥用的默认字体。挑一个有性格、贴合品牌的字族作为主字体。',
  run: (ctx) =>
    eachLineMatch(
      ctx,
      /font-family\s*:\s*['"]?\s*(Inter|Arial|Roboto|Helvetica Neue|Helvetica)\b/gi,
      undefined,
      (m) => `主字体使用了被滥用的「${m[1]}」。挑一个有性格、贴合品牌的字族。`,
    ),
};

const heroFontCeiling: DesignRule = {
  id: 'quality-hero-font-ceiling',
  category: 'quality',
  severity: 'warning',
  minStrictness: 'standard',
  title: 'Display 字号上限',
  message: 'Display 标题 > 6rem（约 96px）像在喊叫而非设计。收回到 6rem 以内。',
  run: (ctx) => {
    const hits: RuleHit[] = [];
    const remSize = /font-size\s*:\s*([\d.]+)rem/gi;
    const clampBody = /font-size\s*:\s*clamp\(([^)]*)\)/gi;
    const twArb = /\btext-\[([\d.]+)rem\]/g;
    const tw9xl = /\btext-9xl\b/;
    for (let i = 0; i < ctx.lines.length; i++) {
      const line = ctx.lines[i];
      const over = (re: RegExp): boolean => {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) if (parseFloat(m[1]) > 6) return true;
        return false;
      };
      // clamp(min, preferred, max)：检查每个 rem 参数，不只最后一个——
      // `clamp(7rem, 5vw, 4rem)` 的最小值就超标。
      const clampOver = (): boolean => {
        clampBody.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = clampBody.exec(line)) !== null) {
          const rems = [...m[1].matchAll(/([\d.]+)rem/g)].map((x) => parseFloat(x[1]));
          if (rems.length > 0 && Math.max(...rems) > 6) return true;
        }
        return false;
      };
      if (over(remSize) || clampOver() || over(twArb) || tw9xl.test(line)) {
        hits.push({ line: i + 1, snippet: snippetOf(line) });
      }
    }
    return hits;
  },
};

const trackingFloor: DesignRule = {
  id: 'quality-display-tracking-floor',
  category: 'quality',
  severity: 'warning',
  minStrictness: 'standard',
  title: '字距下限',
  message:
    '字距 < -0.04em 会让字母粘连。紧凑的 grotesque display 用 -0.02 ~ -0.03em 已足够。',
  run: (ctx) => {
    const css = /letter-spacing\s*:\s*(-[\d.]+)em/gi;
    const tw = /\btracking-\[(-[\d.]+)em\]/g;
    const hits: RuleHit[] = [];
    for (let i = 0; i < ctx.lines.length; i++) {
      const line = ctx.lines[i];
      const tooTight = (re: RegExp): boolean => {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) if (parseFloat(m[1]) < -0.04) return true;
        return false;
      };
      if (tooTight(css) || tooTight(tw)) hits.push({ line: i + 1, snippet: snippetOf(line) });
    }
    return hits;
  },
};

const lineLength: DesignRule = {
  id: 'quality-body-line-length',
  category: 'quality',
  severity: 'warning',
  minStrictness: 'standard',
  title: '正文行宽',
  message: '正文行宽 > 75ch 会降低可读性。把 max-width 控制在 65–75ch。',
  run: (ctx) => {
    const css = /max-width\s*:\s*([\d.]+)ch/gi;
    const tw = /\bmax-w-\[([\d.]+)ch\]/g;
    const hits: RuleHit[] = [];
    for (let i = 0; i < ctx.lines.length; i++) {
      const line = ctx.lines[i];
      const tooWide = (re: RegExp): boolean => {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) if (parseFloat(m[1]) > 75) return true;
        return false;
      };
      if (tooWide(css) || tooWide(tw)) hits.push({ line: i + 1, snippet: snippetOf(line) });
    }
    return hits;
  },
};

const arbitraryZIndex: DesignRule = {
  id: 'quality-arbitrary-z-index',
  category: 'quality',
  severity: 'warning',
  minStrictness: 'standard',
  title: '魔法 z-index',
  message:
    '魔法 z-index（999 / 9999）说明缺少层级体系。建立语义化刻度（dropdown → sticky → modal → toast → tooltip）。',
  run: (ctx) =>
    eachLineMatch(ctx, /z-index\s*:\s*(\d{3,})|(?<![\w-])z-\[(\d{3,})\]/gi, (m) => {
      const n = parseInt(m[1] ?? m[2], 10);
      return n >= 999;
    }),
};

const skippedHeading: DesignRule = {
  id: 'quality-skipped-heading-level',
  category: 'quality',
  severity: 'warning',
  minStrictness: 'standard',
  title: '标题层级跳级',
  message: '标题层级跳级（如 h1 直接到 h3）破坏文档结构与可访问性。逐级递进。',
  run: (ctx) => {
    if (!MARKUP_EXTS.has(ctx.ext) && ctx.ext !== 'jsx' && ctx.ext !== 'tsx') return [];
    const hits: RuleHit[] = [];
    const re = /<h([1-6])\b/gi;
    let prev = 0;
    for (let i = 0; i < ctx.lines.length; i++) {
      const line = ctx.lines[i];
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const level = parseInt(m[1], 10);
        if (prev > 0 && level - prev > 1) {
          hits.push({
            line: i + 1,
            snippet: snippetOf(line),
            message: `标题从 h${prev} 跳到 h${level}，跳过了 h${prev + 1}。逐级递进以保持结构与可访问性。`,
          });
        }
        prev = level;
      }
    }
    return hits;
  },
};

const missingReducedMotion: DesignRule = {
  id: 'quality-missing-reduced-motion',
  category: 'quality',
  severity: 'warning',
  minStrictness: 'standard',
  title: '缺少 reduced-motion',
  message:
    '存在动画但缺少 `@media (prefers-reduced-motion: reduce)` 兜底。这是无障碍必备：提供淡入或瞬时替代。',
  run: (ctx) => {
    if (/prefers-reduced-motion/i.test(ctx.source)) return [];
    // 组件文件里 Tailwind `animate-*` 配 `motion-reduce:`、全局兜底在别处，
    // 故那里只标真正的 CSS 动画原语。样式表与单文件 HTML 走全量检查
    // （transition + Tailwind 工具类），并加锚定让 `data-animate-*` 与
    // `animation:/transition: none` 不误报。
    const motion = COMPONENT_EXTS.has(ctx.ext)
      ? /@keyframes\b|animation\s*:\s*(?!\s*none\b)|animation-name\s*:\s*(?!\s*none\b)|animation-duration\s*:\s*(?!\s*0s\b)\d/i
      : /@keyframes\b|animation\s*:\s*(?!\s*none\b)|animation-name\s*:\s*(?!\s*none\b)|animation-duration\s*:\s*(?!\s*0s\b)\d|transition\s*:\s*(?!\s*none\b)[^;{]*\d|transition-duration\s*:\s*(?!\s*0s\b)\d|(?:^|[\s"'`])animate-(?!none\b)[a-z]/i;
    for (let i = 0; i < ctx.lines.length; i++) {
      if (motion.test(ctx.lines[i])) {
        return [{ line: i + 1, snippet: snippetOf(ctx.lines[i]) }];
      }
    }
    return [];
  },
};

// ── drift：偏离声明的设计语境 ───────────────────────────────────────────────

const fontDrift: DesignRule = {
  id: 'drift-font-not-in-system',
  category: 'drift',
  severity: 'advisory',
  minStrictness: 'strict',
  title: '字体偏离设计语境',
  message: '该字体不在设计语境声明的字族内。',
  run: (ctx) => {
    const allowed = ctx.designContext?.allowedFonts;
    if (!allowed || allowed.length === 0) return [];
    const allowedLower = new Set(allowed.map((f) => f.trim().toLowerCase()));
    return eachLineMatch(
      ctx,
      /font-family\s*:\s*['"]?\s*([A-Za-z][A-Za-z0-9 _-]+?)['"]?\s*[,;}]/gi,
      (m) => {
        const font = m[1].trim().toLowerCase();
        return !GENERIC_FONTS.has(font) && !allowedLower.has(font);
      },
      (m) => `字体「${m[1].trim()}」不在设计语境允许的字族内（${allowed.join('、')}）。`,
    );
  },
};

/** 全部检测规则，按展示顺序。 */
export const DESIGN_RULES: readonly DesignRule[] = [
  purpleBlueGradient,
  bounceEasing,
  creamDefaultBg,
  sideTabBorder,
  gradientText,
  grayTextOnColor,
  grayImagePlaceholder,
  darkColoredGlow,
  overusedFont,
  heroFontCeiling,
  trackingFloor,
  lineLength,
  arbitraryZIndex,
  skippedHeading,
  missingReducedMotion,
  fontDrift,
];
