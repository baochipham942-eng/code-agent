import React, { useEffect } from 'react';
import { Blocks, Boxes, Lightbulb, Link2, Sparkles } from 'lucide-react';
import { useAppStore, type CapabilityHubTab } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { FullScreenPage } from '../shared/FullScreenPage';
import { PageContent } from '../shared/PageContent';
import { ExpertPanel } from '../expert/ExpertPanel';
import { HubTabHeader } from './HubTabHeader';
import { HubTabSlotHost } from '../../../slots/productSlotHosts';

// 重型 tab 一律懒加载：能力中心比设置页开得频繁得多，
// 首屏不该背着技能/连接器/插件/能力清单的注册表。
const SkillsSettings = React.lazy(() => import('../settings/tabs/SkillsSettings').then((m) => ({ default: m.SkillsSettings })));
const MCPSettings = React.lazy(() => import('../settings/tabs/MCPSettings').then((m) => ({ default: m.MCPSettings })));
const PluginsSettings = React.lazy(() => import('../settings/tabs/PluginsSettings').then((m) => ({ default: m.PluginsSettings })));
const CapabilityCandidatesTab = React.lazy(() => import('./CapabilityCandidatesTab').then((m) => ({ default: m.CapabilityCandidatesTab })));

const BUILT_IN_HUB_TABS: Array<{ key: CapabilityHubTab; icon: React.ReactNode; label: (t: ReturnType<typeof useI18n>['t']) => string }> = [
  { key: 'experts', icon: <Boxes className="h-4 w-4" />, label: (t) => t.capabilityHub.tabExperts },
  { key: 'skills', icon: <Sparkles className="h-4 w-4" />, label: (t) => t.capabilityHub.tabSkills },
  { key: 'connectors', icon: <Link2 className="h-4 w-4" />, label: (t) => t.capabilityHub.tabConnectors },
  { key: 'plugins', icon: <Blocks className="h-4 w-4" />, label: (t) => t.capabilityHub.tabPlugins },
  { key: 'candidates', icon: <Lightbulb className="h-4 w-4" />, label: (t) => t.capabilityHub.tabCandidates },
];

export const CapabilityHubPage: React.FC = () => {
  const { t } = useI18n();
  const { capabilityHubTab, openCapabilityHub } = useAppStore();
  const legacyTab = capabilityHubTab as string;
  const activeTab: CapabilityHubTab = legacyTab === 'packages' ? 'plugins' : capabilityHubTab;
  // 提示词管理入口已移走（2026-07-27 二次拍板：它是管理员工具 ⇒ 账号菜单 admin 档，
  // 既不在能力中心 header，也不在设置页）。

  // 旧 packages 深链归并到 plugins；其他失效值仍回退到首个合法 tab，避免白屏。
  useEffect(() => {
    if (legacyTab === 'packages') {
      openCapabilityHub('plugins');
      return;
    }
    if (BUILT_IN_HUB_TABS.some((tab) => tab.key === capabilityHubTab)) return;
    openCapabilityHub(BUILT_IN_HUB_TABS[0].key);
  }, [capabilityHubTab, legacyTab, openCapabilityHub]);

  const content = activeTab === 'experts' ? <ExpertPanel />
    : activeTab === 'skills' ? <SkillsSettings />
    : activeTab === 'connectors' ? <MCPSettings />
    : activeTab === 'plugins' ? <PluginsSettings />
    : activeTab === 'candidates' ? <CapabilityCandidatesTab />
    : null;

  const activeTabLabel = (BUILT_IN_HUB_TABS.find((tab) => tab.key === activeTab) ?? BUILT_IN_HUB_TABS[0]).label(t);

  return (
    <FullScreenPage testId="capability-hub-page" variant="inline">
      {/* 2026-07-27 审美关拍板（对标 WorkBuddy）：顶层 tab 从右上角小胶囊提为顶行主导航，
          本 header 只留 pill 导航；大标题下沉到各 tab 自己的 HubTabHeader，
          这样标题才可能和同 tab 的操作簇同行。 */}
      <header data-tauri-drag-region="deep" className="shrink-0 px-6 pt-4">
        <div className="flex items-center gap-3">
          <nav className="flex items-center gap-1" role="tablist" aria-label={t.capabilityHub.title}>
            {BUILT_IN_HUB_TABS.map(({ key, icon, label }) => (
              <button /* ds-allow:button: 能力中心主导航 pill（role=tab，图标+文案左对齐），Button primitive 无 tab 语义变体 */
                key={key}
                type="button"
                role="tab"
                aria-selected={activeTab === key}
                data-testid={`capability-hub-tab-${key}`}
                onClick={() => openCapabilityHub(key)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                  activeTab === key
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300'
                }`}
              >
                {icon}
                {label(t)}
              </button>
            ))}
            <HubTabSlotHost active />
          </nav>
        </div>
      </header>
      {/* 内容区走 PageContent 契约（全宽 + px-6 py-4），pb-12 保留底部呼吸位 */}
      <PageContent className="pb-12">
        {/* 标题已下沉到各 tab：lazy 加载瞬间用只有标题的 HubTabHeader 占位，切 tab 大标题不闪 */}
        <React.Suspense fallback={<HubTabHeader title={activeTabLabel} />}>
          {content}
        </React.Suspense>
      </PageContent>
    </FullScreenPage>
  );
};
