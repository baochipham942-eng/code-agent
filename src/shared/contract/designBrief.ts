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
  /** 参考截图模式：用户选择"匹配一张参考截图"，生成期需从附带图片提取配色/字体/布局并匹配。 */
  referenceScreenshot?: boolean;
  source?: 'manual' | 'inferred';
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => normalizeText(item))
    .filter((item): item is string => Boolean(item));
  return items.length > 0 ? Array.from(new Set(items)) : undefined;
}

function normalizeDirectionTokens(value: unknown): DirectionTokens | undefined {
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
