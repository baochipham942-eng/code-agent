import React from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { useAppStore, type LocalOpsTab } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';
import { PageContent } from '../shared/PageContent';
import { ComputerUseContent } from '../computerUse/ComputerUseContent';
import { BrowserSurfaceContent } from '../browser/BrowserSurfaceContent';

// 「本机操作」合并整窗页（2026-07-26 导航去重方案 9）：桌面操作与浏览器是
// “Neo 操作本机”的同域能力，页内分段 tab 切换；tab 样式沿用 CapabilityHubPage。
// 内容区走 PageContent 契约（2026-07-27 UX 收尾 1.4）：全 bleed 嵌入画布形态，
// scroll/padding 关闭，布局由被嵌的 ComputerUse/BrowserSurface 内容自管。
const LOCAL_OPS_TABS: Array<{ key: LocalOpsTab; label: (t: ReturnType<typeof useI18n>['t']) => string }> = [
  { key: 'desktop', label: (t) => t.localOps.tabDesktop },
  { key: 'browser', label: (t) => t.localOps.tabBrowser },
];

export const LocalOpsPage: React.FC = () => {
  const { t } = useI18n();
  const { localOpsTab, openLocalOpsPanel } = useAppStore();

  return (
    <FullScreenPage testId="local-ops-page" variant="inline">
      <FullScreenPageHeader
        icon={<MonitorSmartphone className="h-4 w-4 text-badge-info" />}
        title={t.localOps.title}
        description={t.localOps.description}
        actions={(
          <div className="flex rounded-md border border-zinc-700 p-0.5" role="tablist">
            {LOCAL_OPS_TABS.map(({ key, label }) => (
              <button /* ds-allow:button: 本机操作 tab 切换胶囊（role=tab 分段控件），Button primitive 无 tab 语义变体 */ key={key} type="button" role="tab" aria-selected={localOpsTab === key} data-testid={`local-ops-tab-${key}`} onClick={() => openLocalOpsPanel(key)} className={`rounded px-2.5 py-1 text-xs transition-colors ${localOpsTab === key ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}>
                {label(t)}
              </button>
            ))}
          </div>
        )}
      />
      <PageContent scroll={false} padding={false}>
        {localOpsTab === 'browser' ? <BrowserSurfaceContent /> : <ComputerUseContent />}
      </PageContent>
    </FullScreenPage>
  );
};
