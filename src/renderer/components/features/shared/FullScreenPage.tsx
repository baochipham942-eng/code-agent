// ============================================================================
// FullScreenPage / FullScreenPageHeader - 二级页面统一外壳
//
// 外壳契约（2026-07-27 二级页架构批 C 改版，参照 Codex：常驻左栏 + 右侧大标题内容区）：
// - variant="inline"：**不接管整窗**，在 App 右侧内容区内就地铺满（min-w-0 flex-1）。
//   左侧边栏常驻可见。能力中心 / 资料库 / 自动化 / 专家详情 / 知识记忆 / 本机操作 /
//   评测中心走这一档；2026-07-29 起账号菜单打开的设置 / 提示词库 / Lab / 活动 /
//   时间能力 / Neo 协同 / 桌面状态也统一收进这一档（侧栏常驻 + 右侧内容区接管）。
//   纯侧栏切换的 inline 页不给 onClose（header 不画返回按钮，返回语义交给侧栏）；
//   账号菜单这档保留 onClose，画醒目的同行返回按钮（见下方 header 契约）。
// - variant="overlay"（默认，= 改版前行为）：整窗固定覆盖层接管，仅剩真独立页
//   （工作流）——它自带左导航，不参与侧栏三件套的横向切换。
//   默认留在 overlay 是刻意的：新增页不写 variant 时退回旧行为，不会静默漏进右侧区。
//
// header 契约：
// - variant="page"（默认）：标题块坐在内容区顶部，px-6 大标题 + 描述 + 右侧 actions。
//   这是拍板形态（「标题放右边更清晰」），inline 与 overlay 页共用。
// - variant="bar"：h-12 紧凑条，留给仍需紧凑顶栏的 overlay 页（主 TitleBar 已加高到 h-16，
//   这里刻意不跟——overlay 页不在侧栏语境里，不参与四角 padding 那套对称）。
// - onClose 可选：给了才画返回按钮。2026-07-29 起返回按钮与标题同行（标题左侧）、
//   但视觉从属于标题（text-sm 灰字，见 BackButton），标题独占视觉一等位；
//   按钮本体导出为 BackButton，页面内下钻视图（如评测遥测详情）复用同一形制。
// ============================================================================
import React, { createContext, useContext } from 'react';
import { ChevronLeft } from 'lucide-react';
import { getCurrentKeybindingPlatform } from '@shared/keybindings/defaults';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { COLLAPSED_TRAFFIC_LIGHT_INSET } from './trafficLightInset';

// overlay 页整窗接管时，macOS 红绿灯就浮在它左上角（原生标题栏已撤）——
// 主布局靠侧栏首行 h-12 给灯让位，overlay 页没有侧栏，不让位就顶格压在灯下面
// （2026-07-27 产品负责人指出「返回应用太顶格」）。inline 页在侧栏右侧，不受影响。
const OVERLAY_TRAFFIC_LIGHT_INSET = getCurrentKeybindingPlatform() === 'darwin' ? 'pt-7' : '';

type FullScreenPageVariant = 'inline' | 'overlay';
type FullScreenPageHeaderVariant = 'page' | 'bar';

// header 需要知道自己所在的页形态（inline 页参与侧栏/顶栏布局制度，overlay 页整窗接管），
// 由 FullScreenPage 经 context 下发；脱离 FullScreenPage 单用时按 overlay 旧行为。
const FullScreenPageVariantContext = createContext<FullScreenPageVariant>('overlay');

interface FullScreenPageProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  testId?: string;
  variant?: FullScreenPageVariant;
}

interface FullScreenPageHeaderProps {
  icon: React.ReactNode;
  title: string;
  description?: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  /** 省略则不画返回按钮（纯侧栏切换的 inline 页靠侧栏返回） */
  onClose?: () => void;
  /** 返回按钮文案，默认「返回应用」；下钻页（如专家详情）用它说清回哪儿 */
  closeLabel?: string;
  variant?: FullScreenPageHeaderVariant;
}

interface BackButtonProps {
  onClick: () => void;
  label: string;
  testId?: string;
  className?: string;
}

// 共享返回按钮：与标题同行但视觉从属——text-sm 灰字（zinc-500 → hover zinc-200），
// 不与标题同量级（2026-07-29 前是 text-base font-medium，用户反馈看起来像两个标题）。
// 热区保持 h-9（≥32px，参照 Codex 顶栏按钮），降的是字号字重不是可点区域。
// FullScreenPageHeader 的返回按钮就是它；页面内下钻视图（评测遥测详情等）直接复用。
export const BackButton: React.FC<BackButtonProps> = ({ onClick, label, testId, className = '' }) => (
  <button
    type="button"
    onClick={onClick}
    data-testid={testId}
    className={`inline-flex h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-sm text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus:outline-hidden ${className}`}
  >
    <ChevronLeft className="h-4 w-4" />
    <span>{label}</span>
  </button>
);

export const FullScreenPage: React.FC<FullScreenPageProps> = ({
  children,
  className = '',
  testId,
  variant = 'overlay',
  ...divProps
}) => (
  <FullScreenPageVariantContext.Provider value={variant}>
    <div
      {...divProps}
      data-testid={testId}
      data-page-variant={variant}
      className={`${variant === 'overlay' ? `fixed inset-0 z-50 ${OVERLAY_TRAFFIC_LIGHT_INSET}` : 'min-w-0 flex-1'} flex min-h-0 flex-col bg-zinc-900 text-zinc-100 animate-fadeIn ${className}`}
    >
      {children}
    </div>
  </FullScreenPageVariantContext.Provider>
);

export const FullScreenPageHeader: React.FC<FullScreenPageHeaderProps> = ({
  icon,
  title,
  description,
  badge,
  actions,
  onClose,
  closeLabel,
  variant = 'page',
}) => {
  const { t } = useI18n();
  const pageVariant = useContext(FullScreenPageVariantContext);
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const backButton = onClose ? (
    <BackButton
      onClick={onClose}
      label={closeLabel ?? t.settings.backToApp}
      testId="full-screen-page-back"
    />
  ) : null;

  if (variant === 'bar') {
    // inline 页 + 侧栏收起：TitleBar 仍渲染，其展开按钮按红绿灯让位制度坐在 x92，
    // 本行同源让位，返回按钮左缘与它对齐（批P 审美关 2026-07-30，探针实测修前差 76px）。
    // overlay 页整窗接管、不参与顶栏四角制度，保持 px-4。
    const barInset = pageVariant === 'inline' && sidebarCollapsed ? COLLAPSED_TRAFFIC_LIGHT_INSET : '';
    return (
      <header data-tauri-drag-region="deep" className={`flex h-12 shrink-0 items-center justify-between border-b border-border-muted bg-zinc-900 px-4 ${barInset}`}>
        <div className="flex min-w-0 items-center gap-3">
          {backButton}
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-700/70 bg-zinc-800">
            {icon}
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-base font-semibold text-zinc-100">{title}</h2>
              {badge}
            </div>
            {description ? <p className="mt-0.5 truncate text-xs text-zinc-500">{description}</p> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </header>
    );
  }

  // page 形态：标题块坐在内容区顶部（px-6 与 PageContent 同横向节奏），
  // 返回按钮与标题同一行（标题左侧，-ml-2 把按钮内边距借回、让 chevron 与下方
  // 内容左边线对齐），视觉从属于标题；大标题独占视觉一等位、actions 与标题同行
  // 右对齐，描述压在标题下方。
  // 二级页在位时右侧顶栏不渲染，本标题块就是窗口顶部——原生标题栏撤掉后它得能拖窗口。
  // 用 ="deep"：Tauri 的 drag.js 对裸值只认「直接点在该元素上」，内层内容行会把有效区
  // 挤成一条边（2026-07-30 产品负责人：二级页双击标题栏不能缩放）；deep 让整个子树可拖，
  // 按钮/链接等可点元素仍由 Tauri 自动豁免。
  return (
    <header data-tauri-drag-region="deep" className="shrink-0 px-6 pb-4 pt-5" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <div className="flex items-start justify-between gap-4" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div className="flex min-w-0 items-center gap-3">
          {backButton ? <div className="-ml-2 shrink-0">{backButton}</div> : null}
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-zinc-700/70 bg-zinc-800">
            {icon}
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight text-zinc-100">{title}</h1>
              {badge}
            </div>
            {description ? <p className="mt-1 truncate text-sm text-zinc-500">{description}</p> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1">{actions}</div>
      </div>
    </header>
  );
};
