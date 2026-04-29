/**
 * Direction palette inspirations sourced from nexu-io/open-design:
 *   utilitarian → Linear         (indigo brand + violet interactive, dark-native precision)
 *   technical   → HashiCorp      (neutral charcoal parent brand + sharp link blue)
 *   editorial   → warm-editorial (terracotta accent + off-white paper, magazine restraint)
 *   premium     → Apple          (apple blue + light gray, 极简克制让硬件成视觉叙事)
 *   playful     → Lovable        (cream surface + warm gold accent, 温暖人文不喧闹)
 *   calm        → Mintlify       (muted teal + near-white, 文档优先、留白驱动深度)
 *
 * 6 direction hue 分散：editorial 38/60 暖橙、playful 75/90 暖黄、calm 162/165 静绿、
 * technical 250 中性、premium 250 蓝、utilitarian 268/282 紫。两两组合不撞气质。
 */
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
      primary: 'oklch(48% 0.14 268)',
      surface: 'oklch(98% 0.004 268)',
      accent: 'oklch(58% 0.18 282)',
      muted: 'oklch(58% 0.018 268)',
      contrast: 'oklch(18% 0.014 268)',
    },
    fonts: {
      serif: "Charter, 'Iowan Old Style', Georgia, serif",
      sans: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    },
    posture: '刚好够用，不抢戏，信息密度和可扫读性优先；indigo brand 仅在交互处出现。',
  },
  premium: {
    palette: {
      primary: 'oklch(56% 0.16 250)',
      surface: 'oklch(96% 0.003 250)',
      accent: 'oklch(56% 0.16 250)',
      muted: 'oklch(53% 0.005 250)',
      contrast: 'oklch(22% 0.004 250)',
    },
    fonts: {
      serif: "'Iowan Old Style', 'New York', 'Cormorant Garamond', Georgia, serif",
      sans: "'SF Pro Display', 'SF Pro Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
    },
    posture: '有重量、留白、不喧哗；产品至上，界面让位给硬件与材质本身。',
  },
  playful: {
    palette: {
      primary: 'oklch(22% 0.004 60)',
      surface: 'oklch(96% 0.018 90)',
      accent: 'oklch(78% 0.16 75)',
      muted: 'oklch(48% 0.008 70)',
      contrast: 'oklch(22% 0.004 60)',
    },
    fonts: {
      serif: "'Fraunces', 'Iowan Old Style', Georgia, serif",
      sans: "'Camera Plain', 'Nunito Sans', 'Avenir Next', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
    },
    posture: '轻快、有节奏、允许一点意外；温暖奶油底 + 鲜亮跳色，但不牺牲清晰度。',
  },
  editorial: {
    palette: {
      primary: 'oklch(20% 0.012 60)',
      surface: 'oklch(97% 0.012 80)',
      accent: 'oklch(58% 0.16 38)',
      muted: 'oklch(57% 0.012 50)',
      contrast: 'oklch(20% 0.012 60)',
    },
    fonts: {
      serif: "'GT Sectra', 'Newsreader', 'Iowan Old Style', Charter, Georgia, serif",
      sans: "'Söhne', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    },
    posture: '像一页好杂志：terracotta 一屏一个 accent，标题有编辑判断，正文有安静秩序。',
  },
  technical: {
    palette: {
      primary: 'oklch(22% 0.008 250)',
      surface: 'oklch(99% 0.002 250)',
      accent: 'oklch(52% 0.18 252)',
      muted: 'oklch(50% 0.012 250)',
      contrast: 'oklch(15% 0.005 250)',
    },
    fonts: {
      serif: "'IBM Plex Serif', Charter, Georgia, serif",
      sans: "'IBM Plex Sans', Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
    },
    posture: '工程感明确，结构、状态、证据比装饰更重要；charcoal 父品牌只让 link blue 发声。',
  },
  calm: {
    palette: {
      primary: 'oklch(45% 0.05 165)',
      surface: 'oklch(99% 0.003 165)',
      accent: 'oklch(72% 0.13 162)',
      muted: 'oklch(50% 0.012 165)',
      contrast: 'oklch(18% 0.012 165)',
    },
    fonts: {
      serif: "'Source Serif 4', 'Iowan Old Style', Georgia, serif",
      sans: "Inter, 'Avenir Next', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    },
    posture: '安静、稳定、低刺激；文档优先，留白与节奏比色彩更早承担表达。',
  },
};

