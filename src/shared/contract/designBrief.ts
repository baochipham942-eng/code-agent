import type { DirectionTokens } from '../../design/direction-tokens';

export type DesignBriefSurface =
  | 'app_screen'
  | 'landing_page'
  | 'dashboard'
  | 'component'
  | 'document'
  | 'presentation'
  | 'other';

export type DesignBriefDirection =
  | 'utilitarian'
  | 'premium'
  | 'playful'
  | 'editorial'
  | 'technical'
  | 'calm';

export const DESIGN_BRIEF_SURFACE_LABELS: Record<DesignBriefSurface, string> = {
  app_screen: 'App screen',
  landing_page: 'Landing page',
  dashboard: 'Dashboard',
  component: 'Component',
  document: 'Document',
  presentation: 'Presentation',
  other: 'Other',
};

export const DESIGN_BRIEF_DIRECTION_LABELS: Record<DesignBriefDirection, string> = {
  utilitarian: 'Utilitarian',
  premium: 'Premium',
  playful: 'Playful',
  editorial: 'Editorial',
  technical: 'Technical',
  calm: 'Calm',
};

export interface DesignBrief {
  intent?: string;
  surface?: DesignBriefSurface;
  audience?: string;
  constraints?: string[];
  references?: string[];
  direction?: DesignBriefDirection;
  directionTokens?: DirectionTokens;
  /**
   * 用户「品牌契约」的 prompt 相关切片（CD-Parity §1）。完整 tokens 经 directionTokens 注入，
   * 这里只带 keep/change/doNotCopy 三桶约束 + 可选 logo，强制注入护栏管线。
   */
  brandContract?: {
    keep: string[];
    change: string[];
    doNotCopy: string[];
    logoPath?: string;
  };
  /** 参考截图模式：用户选择"匹配一张参考截图"，生成期需从附带图片提取配色/字体/布局并匹配。 */
  referenceScreenshot?: boolean;
  source?: 'manual' | 'inferred';
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => normalizeText(item))
    .filter((item): item is string => Boolean(item));
  return items.length > 0 ? Array.from(new Set(items)) : undefined;
}

export function normalizeDirectionTokens(value: unknown): DirectionTokens | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<DirectionTokens>;
  const palette = raw.palette;
  const fonts = raw.fonts;
  if (!palette || typeof palette !== 'object' || Array.isArray(palette)) return undefined;
  if (!fonts || typeof fonts !== 'object' || Array.isArray(fonts)) return undefined;

  const paletteRaw = palette as Partial<DirectionTokens['palette']>;
  const fontsRaw = fonts as Partial<DirectionTokens['fonts']>;
  const paletteKeys = ['primary', 'surface', 'accent', 'muted', 'contrast'] as const;

  for (const key of paletteKeys) {
    if (!normalizeText(paletteRaw[key])) return undefined;
  }
  if (!normalizeText(fontsRaw.serif) || !normalizeText(fontsRaw.sans)) return undefined;
  const posture = normalizeText(raw.posture);
  if (!posture) return undefined;

  return {
    palette: {
      primary: normalizeText(paletteRaw.primary)!,
      surface: normalizeText(paletteRaw.surface)!,
      accent: normalizeText(paletteRaw.accent)!,
      muted: normalizeText(paletteRaw.muted)!,
      contrast: normalizeText(paletteRaw.contrast)!,
    },
    fonts: {
      serif: normalizeText(fontsRaw.serif)!,
      sans: normalizeText(fontsRaw.sans)!,
    },
    posture,
    refs: normalizeStringList(raw.refs) ?? [],
  };
}

function normalizeBriefBrandContract(value: unknown): DesignBrief['brandContract'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<NonNullable<DesignBrief['brandContract']>>;
  const keep = normalizeStringList(raw.keep) ?? [];
  const change = normalizeStringList(raw.change) ?? [];
  const doNotCopy = normalizeStringList(raw.doNotCopy) ?? [];
  const logoPath = normalizeText(raw.logoPath);
  // 全空（三桶都没内容且无 logo）则丢弃，避免注入空噪声段。
  if (keep.length === 0 && change.length === 0 && doNotCopy.length === 0 && !logoPath) {
    return undefined;
  }
  const result: NonNullable<DesignBrief['brandContract']> = { keep, change, doNotCopy };
  if (logoPath) result.logoPath = logoPath;
  return result;
}

export function normalizeDesignBrief(value?: Partial<DesignBrief> | null): DesignBrief | undefined {
  if (!value) return undefined;

  const brief: DesignBrief = {};
  const intent = normalizeText(value.intent);
  const audience = normalizeText(value.audience);
  const constraints = normalizeStringList(value.constraints);
  const references = normalizeStringList(value.references);
  const directionTokens = normalizeDirectionTokens(value.directionTokens);

  if (intent) brief.intent = intent;
  if (value.surface && value.surface in DESIGN_BRIEF_SURFACE_LABELS) brief.surface = value.surface;
  if (audience) brief.audience = audience;
  if (constraints) brief.constraints = constraints;
  if (references) brief.references = references;
  if (value.direction && value.direction in DESIGN_BRIEF_DIRECTION_LABELS) brief.direction = value.direction;
  if (directionTokens) brief.directionTokens = directionTokens;
  const brandContract = normalizeBriefBrandContract(value.brandContract);
  if (brandContract) brief.brandContract = brandContract;
  if (value.referenceScreenshot === true) brief.referenceScreenshot = true;
  if (value.source === 'manual' || value.source === 'inferred') brief.source = value.source;

  return Object.keys(brief).length > 0 ? brief : undefined;
}

export function formatDesignBriefLabel(brief: DesignBrief): string {
  const parts = [
    brief.surface ? DESIGN_BRIEF_SURFACE_LABELS[brief.surface] : undefined,
    brief.direction ? DESIGN_BRIEF_DIRECTION_LABELS[brief.direction] : undefined,
    brief.intent,
  ].filter((item): item is string => Boolean(item));

  return parts.join(' · ') || 'Design brief';
}
