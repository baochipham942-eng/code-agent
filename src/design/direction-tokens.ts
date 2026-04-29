import type { DesignBriefDirection } from '../shared/contract/designBrief';

export type DirectionKey = DesignBriefDirection;

export interface DirectionPalette {
  primary: string;
  surface: string;
  accent: string;
  muted: string;
  contrast: string;
}

export interface DirectionFontStacks {
  serif: string;
  sans: string;
}

export interface DirectionTokens {
  palette: DirectionPalette;
  fonts: DirectionFontStacks;
  posture: string;
}

export const directionTokens: Record<DirectionKey, DirectionTokens> = {
  utilitarian: {
    palette: {
      primary: 'oklch(46% 0.06 250)',
      surface: 'oklch(98% 0.004 250)',
      accent: 'oklch(62% 0.14 145)',
      muted: 'oklch(62% 0.02 250)',
      contrast: 'oklch(20% 0.018 250)',
    },
    fonts: {
      serif: "Charter, 'Iowan Old Style', Georgia, serif",
      sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif",
    },
    posture: '刚好够用，不抢戏，信息密度和可扫读性优先。',
  },
  premium: {
    palette: {
      primary: 'oklch(24% 0.03 70)',
      surface: 'oklch(97% 0.012 82)',
      accent: 'oklch(62% 0.12 42)',
      muted: 'oklch(58% 0.018 70)',
      contrast: 'oklch(16% 0.018 72)',
    },
    fonts: {
      serif: "'Iowan Old Style', 'New York', 'Cormorant Garamond', Georgia, serif",
      sans: "'SF Pro Display', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
    },
    posture: '有重量、留白、不喧哗，用少量高质细节建立信任。',
  },
  playful: {
    palette: {
      primary: 'oklch(58% 0.18 300)',
      surface: 'oklch(98% 0.018 105)',
      accent: 'oklch(72% 0.18 72)',
      muted: 'oklch(62% 0.045 255)',
      contrast: 'oklch(22% 0.045 285)',
    },
    fonts: {
      serif: "'Fraunces', 'Iowan Old Style', Georgia, serif",
      sans: "'Nunito Sans', 'Avenir Next', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
    },
    posture: '轻快、有节奏、允许一点意外，但不牺牲清晰度。',
  },
  editorial: {
    palette: {
      primary: 'oklch(22% 0.024 58)',
      surface: 'oklch(97% 0.014 80)',
      accent: 'oklch(58% 0.15 32)',
      muted: 'oklch(50% 0.016 60)',
      contrast: 'oklch(14% 0.02 55)',
    },
    fonts: {
      serif: "'Newsreader', 'Iowan Old Style', Charter, Georgia, serif",
      sans: "'Söhne', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    },
    posture: '像一页好杂志，标题有编辑判断，正文有安静秩序。',
  },
  technical: {
    palette: {
      primary: 'oklch(42% 0.08 255)',
      surface: 'oklch(96% 0.006 245)',
      accent: 'oklch(62% 0.16 160)',
      muted: 'oklch(55% 0.024 245)',
      contrast: 'oklch(18% 0.025 245)',
    },
    fonts: {
      serif: "'IBM Plex Serif', Charter, Georgia, serif",
      sans: "'Inter', 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
    },
    posture: '工程感明确，结构、状态、证据比装饰更重要。',
  },
  calm: {
    palette: {
      primary: 'oklch(48% 0.065 190)',
      surface: 'oklch(97% 0.012 180)',
      accent: 'oklch(66% 0.09 165)',
      muted: 'oklch(58% 0.022 195)',
      contrast: 'oklch(22% 0.025 205)',
    },
    fonts: {
      serif: "'Source Serif 4', 'Iowan Old Style', Georgia, serif",
      sans: "'Avenir Next', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    },
    posture: '安静、稳定、低刺激，让内容自然浮出来。',
  },
};

