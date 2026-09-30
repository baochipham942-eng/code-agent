import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// oklch → linear sRGB（Ottosson）→ 钳制进色域 → sRGB。比值用未量化的浮点通道，
// 与审计给出的 amber-600 3.19 / amber-700 5.05 / emerald-600 3.67 对齐。

type Rgb = [number, number, number];
type Slot = 'bg' | 'from' | 'to' | 'text';
type StateName = 'base' | 'hover' | 'disabled';

interface Decl {
  state: StateName;
  slot: Slot;
  token: string;
}

interface ContrastRow {
  id: string;
  theme: string;
  ratio: number;
  pair: string;
  whiteText: boolean;
}

const WHITE: Rgb = [1, 1, 1];

const RAW_SITES = [
  'src/renderer/components/design/CanvasAutonomyReviewBar.tsx',
  'src/renderer/components/design/VariantCompareView.tsx',
  'src/renderer/components/LivePreview/DevServerLauncher.tsx',
  'src/renderer/components/features/settings/tabs/PrivacySettings.tsx',
  'src/renderer/components/features/settings/tabs/SoulSettings.tsx',
  'src/renderer/components/features/settings/sections/NativeDesktopSection.tsx',
  'src/renderer/components/features/chat/ChatInput/VoiceInputButton.tsx',
  'src/renderer/components/features/chat/ChatInput/SendButton.tsx',
  'src/renderer/components/features/lab/gpt1/stages/InferenceTest.tsx',
  'src/renderer/components/features/inAppValidation/InAppValidationWorkspace.tsx',
  'src/renderer/components/features/agentTeam/AgentTeamPanel.tsx',
  'src/renderer/components/ForceUpdateModal.tsx',
];

const PALE_FILL = /(?<![\w-:])((?:[a-z0-9-]+:)*)(bg|from|to)-(primary|amber|emerald|cyan)-(300|400|500|600)(?![\w-])/g;

const readSource = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

function hexToRgb(hex: string): Rgb {
  return [
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

function oklchToSrgb(lightness: number, chroma: number, hueDeg: number): Rgb {
  const hue = (hueDeg * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l_ = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = lightness - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  return linear.map((channel) => {
    const clamped = Math.min(1, Math.max(0, channel));
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  }) as Rgb;
}

function luminance(rgb: Rgb): number {
  const channels = rgb.map((value) => (
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: Rgb, background: Rgb): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

function composite(color: Rgb, alpha: number, backdrop: Rgb): Rgb {
  return color.map((channel, index) => channel * alpha + backdrop[index] * (1 - alpha)) as Rgb;
}

function loadPalette(themeCss: string, tailwindConfig: string): Map<string, Rgb> {
  const palette = new Map<string, Rgb>();
  const oklch = /--color-([a-z0-9]+)-(\d+):\s*oklch\(\s*([0-9.]+)%\s+([0-9.]+)\s+([0-9.]+)\s*\)/g;
  for (const match of themeCss.matchAll(oklch)) {
    palette.set(`${match[1]}-${match[2]}`, oklchToSrgb(
      Number(match[3]) / 100,
      Number(match[4]),
      Number(match[5]),
    ));
  }
  const primaryBlock = tailwindConfig.match(/primary:\s*\{([^}]+)\}/)?.[1];
  if (!primaryBlock) throw new Error('tailwind.config.js 缺少 primary 色阶');
  for (const match of primaryBlock.matchAll(/(\d+):\s*'(#[0-9a-fA-F]{6})'/g)) {
    palette.set(`primary-${match[1]}`, hexToRgb(match[2]));
  }
  for (const required of ['amber-500', 'amber-600', 'amber-700', 'red-600', 'primary-700', 'emerald-700', 'cyan-700']) {
    if (!palette.has(required)) throw new Error(`色板缺少 ${required}`);
  }
  return palette;
}

function readHexToken(css: string, token: string): Rgb {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`主题缺少 ${token}`);
  return hexToRgb(match[1]);
}

function extractJoinedVariant(source: string, name: string): string {
  const match = source.match(new RegExp(`${name}:\\s*\\[([\\s\\S]*?)\\]\\.join\\(' '\\)`));
  if (!match) throw new Error(`Button 缺少变体 ${name}`);
  const literals = [...match[1].matchAll(/'([^'\\]*)'/g)].map((item) => item[1]);
  if (literals.length === 0) throw new Error(`变体 ${name} 没有类字符串`);
  return literals.join(' ');
}

function extractConfirmClass(
  source: string,
  variant: string,
  button: { primary: string; danger: string },
): string {
  const match = source.match(new RegExp(`${variant}:\\s*\\{([\\s\\S]*?)\\n  \\},`));
  if (!match) throw new Error(`ConfirmDialog 缺少变体 ${variant}`);
  const raw = match[1].match(/confirmColorClass:\s*([^,\n]+)/)?.[1]?.trim();
  if (!raw) throw new Error(`ConfirmDialog ${variant} 缺少 confirmColorClass`);
  if (raw === 'BUTTON_PRIMARY_CLASS') return button.primary;
  if (raw === 'BUTTON_DANGER_CLASS') return button.danger;
  const literal = raw.match(/^'([^']*)'$/);
  if (!literal) throw new Error(`无法解析 ${variant} 的 confirmColorClass：${raw}`);
  return literal[1];
}

function parseDecls(classString: string): Decl[] {
  const decls: Decl[] = [];
  for (const token of classString.split(/\s+/)) {
    if (!token) continue;
    const match = token.match(/^(?:(?<variants>[a-z0-9-]+:))*(?<slot>bg|from|to|text)-(?<value>.+)$/);
    const groups = match?.groups;
    if (!groups?.slot || !groups.value) continue;
    if (groups.slot === 'bg' && groups.value.startsWith('gradient')) continue;
    const parts = (groups.variants ?? '').split(':').filter(Boolean);
    if (parts.includes('dark')) continue;
    if (parts.some((part) => part !== 'hover' && part !== 'disabled')) continue;
    const slot = groups.slot as Slot;
    const state: StateName = parts.includes('disabled') ? 'disabled' : parts.includes('hover') ? 'hover' : 'base';
    decls.push({ state, slot, token: groups.value });
  }
  return decls;
}

function resolveState(decls: Decl[], state: StateName): Partial<Record<Slot, string>> {
  const resolved: Partial<Record<Slot, string>> = {};
  for (const decl of decls) {
    if (decl.state === 'base') resolved[decl.slot] = decl.token;
  }
  if (state !== 'base') {
    for (const decl of decls) {
      if (decl.state === state) resolved[decl.slot] = decl.token;
    }
  }
  return resolved;
}

function fillTokens(resolved: Partial<Record<Slot, string>>): Array<{ slot: 'bg' | 'from' | 'to'; token: string }> {
  const stops = (['from', 'to'] as const)
    .map((slot) => ({ slot, token: resolved[slot] }))
    .filter((item): item is { slot: 'from' | 'to'; token: string } => Boolean(item.token) && item.token !== 'transparent');
  if (stops.length > 0) return stops;
  if (resolved.bg && resolved.bg !== 'transparent') return [{ slot: 'bg', token: resolved.bg }];
  return [];
}

function parseAlpha(token: string): { name: string; alpha: number } {
  const [name, alphaRaw] = token.split('/');
  if (!alphaRaw) return { name, alpha: 1 };
  if (alphaRaw.startsWith('[')) return { name, alpha: Number(alphaRaw.slice(1, -1)) };
  return { name, alpha: Number(alphaRaw) / 100 };
}

function materialize(
  token: string,
  slot: Slot,
  themeCss: string | null,
  palette: Map<string, Rgb>,
): { rgb: Rgb; label: string } {
  const { name, alpha } = parseAlpha(token);
  if (name === 'white') return { rgb: WHITE, label: 'white' };
  if (name === 'btn-secondary-disabled') {
    if (!themeCss) throw new Error('token 色需要主题文件');
    const cssToken = slot === 'text' ? '--btn-secondary-fg-disabled' : '--btn-secondary-bg-disabled';
    return { rgb: readHexToken(themeCss, cssToken), label: cssToken };
  }
  const rgb = palette.get(name);
  if (!rgb) throw new Error(`未知填充色 ${name}`);
  if (alpha === 1) return { rgb, label: name };
  return { rgb: composite(rgb, alpha, WHITE), label: `${name}/${alpha} on #fff` };
}

function rowsFor(
  subject: string,
  classString: string,
  fallbackWhite: boolean,
  palette: Map<string, Rgb>,
  themes: { light: string; dark: string },
): ContrastRow[] {
  const decls = parseDecls(classString);
  const rows: ContrastRow[] = [];
  for (const state of ['base', 'hover', 'disabled'] as const) {
    const resolved = resolveState(decls, state);
    const fills = fillTokens(resolved);
    if (fills.length === 0) continue;
    const textToken = resolved.text;
    if (!textToken && (!fallbackWhite || state === 'disabled')) continue;
    const usesTheme = [textToken, ...fills.map((fill) => fill.token)]
      .some((token) => token?.startsWith('btn-'));
    const themeNames = usesTheme ? (['light', 'dark'] as const) : (['solid'] as const);
    for (const themeName of themeNames) {
      const themeCss = themeName === 'dark' ? themes.dark : themeName === 'light' ? themes.light : null;
      const foreground = textToken
        ? materialize(textToken, 'text', themeCss, palette)
        : { rgb: WHITE, label: 'white' };
      for (const fill of fills) {
        const background = materialize(fill.token, fill.slot, themeCss, palette);
        rows.push({
          id: `${subject}.${state}.${fill.slot}`,
          theme: themeName,
          ratio: contrast(foreground.rgb, background.rgb),
          pair: `${foreground.label} / ${background.label}`,
          whiteText: foreground.label === 'white',
        });
      }
    }
  }
  return rows;
}

function formatTable(rows: ContrastRow[]): string {
  const header = 'subject                          theme  ratio  pair';
  const lines = rows.map((row) => [
    row.id.padEnd(32),
    row.theme.padEnd(6),
    row.ratio.toFixed(2).padStart(5),
    row.pair,
  ].join('  '));
  return ['SOLID_FILL_CONTRAST_TABLE', header, ...lines].join('\n');
}

function unguardedPaleFills(source: string, file: string): string[] {
  const hits: string[] = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes('text-white')) continue;
    for (const match of line.matchAll(PALE_FILL)) {
      const prefix = match[1] ?? '';
      if (prefix.split(':').filter(Boolean).includes('dark')) continue;
      hits.push(`${file}:${index + 1} ${match[0]}`);
    }
  }
  return hits;
}

const themeCss = readSource('node_modules/tailwindcss/theme.css');
const tailwindConfig = readSource('tailwind.config.js');
const palette = loadPalette(themeCss, tailwindConfig);
const buttonSource = readSource('src/renderer/components/primitives/Button.tsx');
const dialogSource = readSource('src/renderer/components/composites/ConfirmDialog.tsx');
const modalSource = readSource('src/renderer/components/primitives/Modal.tsx');
const lightCss = readSource('src/renderer/styles/themes/light.css');
const darkCss = readSource('src/renderer/styles/themes/dark.css');
const button = {
  primary: extractJoinedVariant(buttonSource, 'primary'),
  danger: extractJoinedVariant(buttonSource, 'danger'),
};
const dialog = {
  info: extractConfirmClass(dialogSource, 'info', button),
  warning: extractConfirmClass(dialogSource, 'warning', button),
  danger: extractConfirmClass(dialogSource, 'danger', button),
};
const themes = { light: lightCss, dark: darkCss };
const rows = [
  ...rowsFor('button.primary', button.primary, false, palette, themes),
  ...rowsFor('button.danger', button.danger, false, palette, themes),
  ...rowsFor('dialog.info', dialog.info, true, palette, themes),
  ...rowsFor('dialog.warning', dialog.warning, true, palette, themes),
  ...rowsFor('dialog.danger', dialog.danger, true, palette, themes),
];

describe('实心白字填充对比度', () => {
  it('从 theme.css 的 oklch 和 tailwind primary 算出与审计一致的比值', () => {
    const ratio = (name: string) => {
      const rgb = palette.get(name);
      if (!rgb) throw new Error(`缺少 ${name}`);
      return contrast(WHITE, rgb);
    };
    expect(ratio('amber-500')).toBeCloseTo(2.15, 1);
    expect(ratio('amber-600')).toBeCloseTo(3.19, 1);
    expect(ratio('amber-700')).toBeCloseTo(5.05, 1);
    expect(ratio('emerald-600')).toBeCloseTo(3.67, 1);
    expect(ratio('cyan-600')).toBeCloseTo(3.6, 1);
    expect(ratio('primary-500')).toBeCloseTo(2.5, 1);
    expect(ratio('primary-600')).toBeCloseTo(3.7, 1);
    expect(ratio('primary-700')).toBeCloseTo(5.47, 1);
    expect(ratio('primary-800')).toBeCloseTo(7.58, 1);
    expect(ratio('red-600')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('emerald-700')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('cyan-700')).toBeGreaterThanOrEqual(4.5);
  });

  it('Button 与 ConfirmDialog 的启用、hover、禁用填充都不低于 4.5', () => {
    const footer = modalSource.slice(modalSource.indexOf('export const ModalFooter'));
    expect(footer).toContain('text-white');
    expect(footer).toContain(': confirmColorClass');

    console.log(formatTable(rows));

    const required = [
      'button.primary.base',
      'button.primary.hover',
      'button.danger.base',
      'button.danger.hover',
      'dialog.info.base',
      'dialog.info.hover',
      'dialog.warning.base',
      'dialog.warning.hover',
      'dialog.danger.base',
      'dialog.danger.hover',
    ];
    for (const key of required) {
      const matches = rows.filter((row) => row.id.startsWith(`${key}.`) && row.whiteText);
      expect(matches.length, `${key} 没有白字填充行`).toBeGreaterThan(0);
    }
    for (const row of rows) {
      expect(row.ratio, `${row.id} ${row.theme} ${row.pair} ${row.ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('主按钮和危险按钮的禁用态使用 secondary disabled token，浅色比值不低于该对自身', () => {
    for (const classString of [button.primary, button.danger]) {
      expect(classString).toContain('disabled:from-transparent');
      expect(classString).toContain('disabled:to-transparent');
      expect(classString).toContain('disabled:bg-btn-secondary-disabled');
      expect(classString).toContain('disabled:text-btn-secondary-disabled');
      expect(classString).toContain('disabled:shadow-none');
    }
    expect(button.primary).not.toContain('disabled:from-primary-800/50');
    expect(button.primary).not.toContain('disabled:to-primary-700/50');
    expect(button.danger).not.toContain('disabled:bg-red-600/50');

    const secondaryLight = contrast(
      readHexToken(lightCss, '--btn-secondary-fg-disabled'),
      readHexToken(lightCss, '--btn-secondary-bg-disabled'),
    );
    const secondaryDark = contrast(
      readHexToken(darkCss, '--btn-secondary-fg-disabled'),
      readHexToken(darkCss, '--btn-secondary-bg-disabled'),
    );
    for (const subject of ['button.primary.disabled', 'button.danger.disabled']) {
      const light = rows.find((row) => row.id.startsWith(subject) && row.theme === 'light');
      const dark = rows.find((row) => row.id.startsWith(subject) && row.theme === 'dark');
      expect(light, `${subject} light`).toBeTruthy();
      expect(dark, `${subject} dark`).toBeTruthy();
      expect(light?.ratio, `${subject} light ${light?.ratio.toFixed(2)}`).toBeGreaterThanOrEqual(secondaryLight);
      expect(dark?.ratio, `${subject} dark ${dark?.ratio.toFixed(2)}`).toBeGreaterThanOrEqual(secondaryDark);
      expect(light?.ratio).toBeGreaterThanOrEqual(4.5);
      expect(dark?.ratio).toBeGreaterThanOrEqual(4.5);
    }
    console.log([
      `secondary-disabled light ${secondaryLight.toFixed(2)}`,
      `secondary-disabled dark ${secondaryDark.toFixed(2)}`,
    ].join('\n'));
  });

  it('列出的手搓白字元素没有无 dark: 守卫的 300–600 档填充', () => {
    expect(unguardedPaleFills('className="dark:bg-primary-500 text-white"', 'fixture')).toEqual([]);
    expect(unguardedPaleFills('className="dark:hover:from-amber-400 text-white"', 'fixture')).toEqual([]);
    expect(unguardedPaleFills('className="bg-primary-500 text-white"', 'fixture')).toEqual([
      'fixture:1 bg-primary-500',
    ]);
    expect(unguardedPaleFills('className="hover:bg-amber-600 text-white"', 'fixture')).toEqual([
      'fixture:1 hover:bg-amber-600',
    ]);

    const hits = RAW_SITES.flatMap((file) => unguardedPaleFills(readSource(file), file));
    expect(hits, hits.join('\n')).toEqual([]);
  });
});
