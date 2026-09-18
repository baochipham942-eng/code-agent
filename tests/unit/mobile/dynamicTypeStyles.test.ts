import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// N-MOBILE-DYNAMIC-TYPE 守卫：手机 App 跟随 iOS 系统字号（-apple-system-body 通道），极端档由 clamp 收住；
// Android WebView 不识别该关键字，走默认分支的 px，渲染与引入变量前逐字节一致。
// 对 styles.css 做静态结构检查（写法同 iosPackage.test.ts 的 readFileSync 模式）。

const css = readFileSync('packages/mobile/src/styles.css', 'utf8');
// 结构解析基于去注释后的文本；只有 ①（裸 px 禁令）按任务书口径查全文。
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 从 `{` 下标截到配对的 `}`（@supports 内嵌 :root，`[^}]` 一层吃不下）。 */
function balancedBlock(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(openIndex, i + 1);
  }
  throw new Error('DYNAMIC_TYPE_CSS_UNBALANCED');
}

function parseTiers(block: string): Map<string, string> {
  return new Map([...block.matchAll(/(--fs-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
}

// iOS 默认 L 档下 1rem = 17px：clamp 中值写的是 rem，换算回 px 才能与默认分支的现值对账。
const REM_PX = 17;

const supportsIndex = bare.search(/@supports\s*\(\s*font:\s*-apple-system-body\s*\)\s*\{/);
const supportsBlock = supportsIndex >= 0 ? balancedBlock(bare, bare.indexOf('{', supportsIndex)) : null;

describe('mobile dynamic type styles', () => {
  it('has no fixed px font-size left anywhere in styles.css (every size must go through a --fs-* tier)', () => {
    // 新增字号一律进档位变量；确需例外得在此逐处点名并写明理由，目标为零。
    expect([...css.matchAll(/font-size:\s*[\d.]+px/g)].map(m => m[0])).toEqual([]);
  });

  it('declares every tier as plain px in the default :root that precedes @supports (Android / non-iOS fallback)', () => {
    expect(supportsBlock, '@supports 分支缺失').toBeTruthy();
    // 默认分支必须出现在 @supports 之前：同为 :root 特异性相同，靠后者覆盖前者。
    const tierBlocks = [...bare.slice(0, supportsIndex).matchAll(/:root\s*\{[^}]*\}/g)].map(m => m[0]).filter(b => /--fs-/.test(b));
    expect(tierBlocks, '默认 :root 档位定义缺失或出现多块').toHaveLength(1);
    for (const [name, value] of parseTiers(tierBlocks[0])) {
      // 默认分支出现 rem/clamp 会改掉 Android 渲染——那边 1rem 固定 16px，跟 iOS 的 17px 基准不同步。
      expect(value, `${name} 默认值必须是纯 px，现在是 ${value}`).toMatch(/^[\d.]+px$/);
    }
  });

  it('re-clamps every tier inside @supports: three-part px/rem/px with lower < current value < upper', () => {
    expect(supportsBlock).toBeTruthy();
    const defaults = parseTiers([...bare.slice(0, supportsIndex).matchAll(/:root\s*\{[^}]*\}/g)].map(m => m[0]).find(b => /--fs-/.test(b))!);
    const inner = supportsBlock!.match(/:root\s*\{[^}]*\}/);
    expect(inner, '@supports 内缺 :root 档位重定义').toBeTruthy();
    const clamped = parseTiers(inner![0]);
    // 两分支档位集合必须一致：只在 @supports 里定义的档位在 Android 上解析不了（var 无 fallback 时整条字号退化成继承）。
    expect([...clamped.keys()].sort()).toEqual([...defaults.keys()].sort());

    for (const [name, value] of clamped) {
      const m = value.match(/^clamp\(([\d.]+)px,\s*([\d.]+)rem,\s*([\d.]+)px\)$/);
      expect(m, `${name} 必须是 clamp(下限px, 中值rem, 上限px) 三段式，现在是 ${value}`).toBeTruthy();
      const lower = Number(m![1]);
      const midPx = Number(m![2]) * REM_PX;
      const upper = Number(m![3]);
      const current = Number(defaults.get(name)!.replace('px', ''));
      // 中值 = 现值/17 的 rem：默认 L 档下与改前逐像素一致（容差盖住 rem 的 4 位小数舍入，<0.01px）。
      expect(Math.abs(midPx - current), `${name} clamp 中值 ≈${midPx.toFixed(4)}px 应等于现值 ${current}px`).toBeLessThan(0.01);
      expect(lower, `${name} 下限 ${lower}px 应小于现值 ${current}px`).toBeLessThan(current);
      expect(current, `${name} 现值 ${current}px 应小于上限 ${upper}px`).toBeLessThan(upper);
    }
  });

  it('pins html to the system font channel with line-height restored after the shorthand', () => {
    const html = supportsBlock?.match(/html\s*\{[^}]*\}/)?.[0];
    expect(html, '@supports 内缺 html 规则').toBeTruthy();
    expect(html).toContain('font: -apple-system-body');
    expect(html).toContain('line-height: normal');
    // font 简写会重置 line-height：normal 必须写在简写之后，否则系统行高漏进继承链。
    expect(html!.indexOf('line-height')).toBeGreaterThan(html!.indexOf('font:'));
  });

  it('sizes .app through the body tier instead of pinning the inheritance chain', () => {
    const app = bare.match(/\.app\s*\{[^}]*\}/)?.[0];
    expect(app, '.app 规则缺失').toBeTruthy();
    expect(app).toMatch(/font-size:\s*var\(--fs-body\)/);
  });

  it('keeps the out-of-.app boot screen on a declared tier so the default L tier stays pixel-identical', () => {
    // .loading 在 .app 之外：html 接系统字号后若不钉一档，iOS 默认档这段文字会 16→17px。
    expect(bare).toMatch(/\.loading\s+p\s*\{[^}]*font-size:\s*var\(--fs-msg\)[^}]*\}/);
  });

  it('only references tiers that the default :root defines', () => {
    const defaults = parseTiers([...bare.slice(0, supportsIndex).matchAll(/:root\s*\{[^}]*\}/g)].map(m => m[0]).find(b => /--fs-/.test(b))!);
    const used = new Set([...bare.matchAll(/var\((--fs-[a-z0-9-]+)\)/g)].map(m => m[1]));
    expect([...used].filter(name => !defaults.has(name)), '存在未定义的档位引用').toEqual([]);
  });
});
