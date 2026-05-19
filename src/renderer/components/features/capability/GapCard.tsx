// ============================================================================
// GapCard — Step 7 PR 3
//
// 当 `recommend_capability` tool 返回 `meta.gaps` 时，InlineWorkbenchBar 下方
// 渲染本卡片，引导用户消除能力缺口（装插件 / 切模型 / 填 API key）。
//
// 设计原则：
// - 单一形态：不接 theme / variant / size 等扩展点，本 PR 只做一个样式
// - CTA 决策抽离纯函数 `getGapCardActions`，方便单测 / 不依赖 React 渲染
// - 本地已有候选 plugin 时跳转插件管理；没有候选时仍禁用安装 CTA
// - 不主动跑诊断：本组件是纯 presentational + dispatch，扫描由 main service 做
// ============================================================================

import React from 'react';
import { AlertTriangle, ExternalLink, KeyRound, Package, Sparkles, X } from 'lucide-react';
import type { SettingsTab } from '../../../utils/settingsTabs';
import type { CapabilityGap } from '../../../../shared/contract/capabilityGap';
import { useAppStore } from '../../../stores/appStore';

// ────────────────────────────────────────────────────────────────────────────
// Pure helpers — 单测覆盖的核心逻辑
// ────────────────────────────────────────────────────────────────────────────

export interface GapCardActionHandlers {
  /** 打开 Settings 并定位到指定 tab */
  openSettingsTab: (tab: SettingsTab) => void;
  /** 关闭整张卡片 */
  onDismiss: () => void;
}

export interface GapCardAction {
  /** 按钮可见文案 */
  label: string;
  /** 点击行为；disabled=true 时 onClick 仍是 noop 以保持 type 一致 */
  onClick: () => void;
  /** 是否禁用 */
  disabled: boolean;
  /** 鼠标悬停 tooltip（解释 disabled 原因） */
  tooltip?: string;
  /** 辅助 hint（在 CTA 下方独立渲染一行说明） */
  hint?: string;
  /** 强调级别：'primary' = 主操作；'ghost' = 次要 */
  emphasis: 'primary' | 'ghost';
}

/**
 * 根据 gap 类型决定 CTA。纯函数，便于单测。
 *
 * - PluginGap：disabled 主 CTA + tooltip 提示 marketplace 未接入
 * - ModelGap：跳 Settings.model tab，让用户挑模型
 * - ApiKeyGap：跳 Settings.model tab + hint 指向 Providers 区块的具体 provider
 */
export function getGapCardActions(
  gap: CapabilityGap,
  handlers: GapCardActionHandlers,
): GapCardAction {
  switch (gap.type) {
    case 'plugin':
      if (gap.candidates.length > 0) {
        return {
          label: '去启用插件',
          onClick: () => handlers.openSettingsTab('plugins'),
          disabled: false,
          hint: `候选: ${gap.candidates.map((candidate) => candidate.name).slice(0, 3).join('、')}`,
          emphasis: 'primary',
        };
      }
      return {
        label: '安装插件',
        onClick: () => {},
        disabled: true,
        tooltip: 'marketplace 接入后开放',
        emphasis: 'primary',
      };
    case 'model':
      return {
        label: '去切换模型',
        onClick: () => handlers.openSettingsTab('model'),
        disabled: false,
        emphasis: 'primary',
      };
    case 'apikey':
      return {
        label: `去填 ${gap.provider} API key`,
        onClick: () => handlers.openSettingsTab('model'),
        disabled: false,
        hint: `在 Providers 区块找到 ${gap.provider} 配置 key`,
        emphasis: 'primary',
      };
  }
}

/** Discriminated union narrowing helper（i18n / 文案聚合在一处） */
export function getGapHeadline(
  gap: CapabilityGap,
  requiredCapability: string,
): string {
  switch (gap.type) {
    case 'plugin':
      return `需要安装支持 ${requiredCapability} 的插件`;
    case 'model':
      return `当前模型不支持 ${gap.missing} 能力`;
    case 'apikey':
      return `${gap.provider} 未配置 API key`;
  }
}

/** 候选列表副文案（空候选时给出兜底） */
export function getGapSubtext(gap: CapabilityGap): string | null {
  switch (gap.type) {
    case 'plugin':
      if (gap.candidates.length === 0) {
        return 'marketplace 未接入，本地暂无候选插件';
      }
      return `候选插件: ${gap.candidates.map((c) => c.name).join('、')}`;
    case 'model':
      if (gap.candidates.length === 0) {
        return '所有已注册模型都不具备该能力，请考虑切换 provider';
      }
      return `候选模型: ${gap.candidates
        .slice(0, 3)
        .map((c) => `${c.provider}/${c.model}`)
        .join('、')}${gap.candidates.length > 3 ? ' 等' : ''}`;
    case 'apikey':
      return `已有模型支持 ${gap.missing}，缺一把 key 即可启用`;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// React component
// ────────────────────────────────────────────────────────────────────────────

interface GapIconProps {
  type: CapabilityGap['type'];
}

const GapIcon: React.FC<GapIconProps> = ({ type }) => {
  switch (type) {
    case 'plugin':
      return <Package className="h-3.5 w-3.5 text-amber-400" aria-hidden />;
    case 'model':
      return <Sparkles className="h-3.5 w-3.5 text-sky-400" aria-hidden />;
    case 'apikey':
      return <KeyRound className="h-3.5 w-3.5 text-fuchsia-400" aria-hidden />;
  }
};

export interface GapCardProps {
  /** 引发本次诊断的 capability 标签（kebab-case） */
  requiredCapability: string;
  /** 待消化的能力缺口列表 */
  gaps: CapabilityGap[];
  /** 用户点关闭 ✕ 时触发 */
  onDismiss?: () => void;
}

export const GapCard: React.FC<GapCardProps> = ({
  requiredCapability,
  gaps,
  onDismiss,
}) => {
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);

  if (gaps.length === 0) {
    return null;
  }

  const handlers: GapCardActionHandlers = {
    openSettingsTab,
    onDismiss: onDismiss ?? (() => {}),
  };

  return (
    <div
      className="mb-2 rounded-xl border border-amber-500/15 bg-amber-500/[0.04] px-3 py-2"
      role="region"
      aria-label="能力缺口提示"
      data-testid="gap-card"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] text-amber-200">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          <span>
            能力缺口: <code className="rounded bg-white/[0.06] px-1">{requiredCapability}</code>
          </span>
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
            aria-label="关闭能力缺口提示"
            data-testid="gap-card-dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="mt-2 space-y-2">
        {gaps.map((gap, idx) => {
          const action = getGapCardActions(gap, handlers);
          const headline = getGapHeadline(gap, requiredCapability);
          const subtext = getGapSubtext(gap);
          // key 拼一个稳定的判别串：type + missing + (provider for apikey)
          const key =
            gap.type === 'apikey'
              ? `${gap.type}:${gap.missing}:${gap.provider}`
              : `${gap.type}:${gap.missing}:${idx}`;
          return (
            <div
              key={key}
              className="rounded-lg border border-white/[0.06] bg-zinc-900/40 px-2.5 py-2"
              data-testid={`gap-card-item-${gap.type}`}
            >
              <div className="flex items-start gap-2">
                <div className="mt-0.5">
                  <GapIcon type={gap.type} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-zinc-200">{headline}</div>
                  {subtext && (
                    <div className="mt-0.5 text-[11px] text-zinc-400 leading-relaxed">
                      {subtext}
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={action.onClick}
                      disabled={action.disabled}
                      title={action.tooltip}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                        action.emphasis === 'primary'
                          ? 'border-amber-500/30 bg-amber-500/10 text-amber-200 hover:border-amber-500/50 hover:bg-amber-500/15'
                          : 'border-white/[0.08] bg-zinc-900/60 text-zinc-300 hover:border-white/[0.14]'
                      }`}
                      data-testid={`gap-card-cta-${gap.type}`}
                    >
                      <span>{action.label}</span>
                      {!action.disabled && <ExternalLink className="h-3 w-3" aria-hidden />}
                    </button>
                  </div>
                  {action.hint && (
                    <div
                      className="mt-1 text-[11px] text-zinc-500"
                      data-testid={`gap-card-hint-${gap.type}`}
                    >
                      {action.hint}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default GapCard;
