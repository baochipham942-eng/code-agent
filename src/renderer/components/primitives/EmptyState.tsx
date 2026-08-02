import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { PlanetSphere, type PlanetKind } from '../brand/PlanetSphere';

/**
 * 空态视觉变体——逐一对应迁移前各调用点的既有形态（视觉保真，不新造样式）：
 * - box    : 虚线边框卡片，仅文本（原 PluginsSettings 局部定义）
 * - panel  : 虚线边框面板，图标+标题+文本（原 KnowledgeMemoryPanel.parts 局部定义）
 * - plain  : 无边框居中，图标+标题+文本（原 PlanningPanel 局部定义）
 * - inline : 单行浅色文本（原 TaskPanel/Card 的 CardEmptyState）
 */
export type EmptyStateVariant = 'box' | 'panel' | 'plain' | 'inline';

/** 星球空态（2026-08-02 星球品牌升级）：在原图标位渲染 34px PlanetSphere。 */
interface EmptyStatePlanet {
  kind: PlanetKind;
  /** 辉光色（rgba 字符串）；缺省用中性灰蓝，不为场景硬编码状态色 */
  glowColor?: string;
}

export interface EmptyStateProps {
  variant?: EmptyStateVariant;
  icon?: LucideIcon;
  /**
   * 可选星球：传了就在图标位渲染 34px PlanetSphere（替代 icon）。
   * 这是原语的可选属性，不是第 5 种变体——下文的"第 5 形态先归并"约定不变；
   * 不带 planet 的 4 个变体行为零变化。box/inline 没有图标位，planet 对它们不生效。
   */
  planet?: EmptyStatePlanet;
  title?: React.ReactNode;
  text: React.ReactNode;
}

/** 空态星球统一慢转 20s/周（欢迎页主视觉地球是 24s，空态点缀更慢一档不抢戏） */
const EMPTY_STATE_PLANET_SPIN_SECONDS = 20;
/** 缺省辉光：中性灰蓝（zinc-400 同族），场景色由各调用点显式传 glowColor */
const EMPTY_STATE_PLANET_DEFAULT_GLOW = 'rgba(148,163,184,.20)';

// ponytail: 变体=既有调用点形态的枚举，不开放自由 className；出现第 5 种形态时先想想能不能归并进这 4 种
// （planet 不是第 5 种形态：它只是图标位的可选内容，4 变体的结构/排版一律不动）
export const EmptyState: React.FC<EmptyStateProps> = ({ variant = 'box', icon: Icon, planet, title, text }) => {
  const planetNode = planet ? (
    <PlanetSphere
      kind={planet.kind}
      spinSeconds={EMPTY_STATE_PLANET_SPIN_SECONDS}
      glowColor={planet.glowColor ?? EMPTY_STATE_PLANET_DEFAULT_GLOW}
      size={34}
    />
  ) : null;
  switch (variant) {
    case 'inline':
      return <div className="text-xs text-zinc-600 py-1">{text}</div>;
    case 'panel':
      return (
        <div className="flex h-full min-h-[220px] flex-col items-center justify-center rounded-lg border border-dashed border-zinc-800 px-6 text-center">
          {planetNode ?? (Icon && <Icon className="h-8 w-8 text-zinc-600" />)}
          {title && <h4 className="mt-3 text-sm font-medium text-zinc-300">{title}</h4>}
          <p className="mt-1 max-w-sm text-xs leading-5 text-zinc-500">{text}</p>
        </div>
      );
    case 'plain':
      return (
        <div className="flex flex-col items-center justify-center h-full text-center p-4">
          {planetNode
            ? <span className="mb-3 inline-flex">{planetNode}</span>
            : Icon && <Icon className="w-12 h-12 text-zinc-600 mb-3" />}
          {title && <p className="text-sm text-zinc-400">{title}</p>}
          <p className="text-xs text-zinc-500 mt-1">{text}</p>
        </div>
      );
    case 'box':
    default:
      return (
        <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/35 px-4 py-6 text-center text-sm text-zinc-500">
          {text}
        </div>
      );
  }
};
