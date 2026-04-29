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

export function normalizeDesignBrief(value?: Partial<DesignBrief> | null): DesignBrief | undefined {
  if (!value) return undefined;

  const brief: DesignBrief = {};
  const intent = normalizeText(value.intent);
  const audience = normalizeText(value.audience);
  const constraints = normalizeStringList(value.constraints);
  const references = normalizeStringList(value.references);

  if (intent) brief.intent = intent;
  if (value.surface && value.surface in DESIGN_BRIEF_SURFACE_LABELS) brief.surface = value.surface;
  if (audience) brief.audience = audience;
  if (constraints) brief.constraints = constraints;
  if (references) brief.references = references;
  if (value.direction && value.direction in DESIGN_BRIEF_DIRECTION_LABELS) brief.direction = value.direction;
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
