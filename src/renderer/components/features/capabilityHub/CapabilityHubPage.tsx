import React, { useEffect, useMemo } from 'react';
import { Blocks, Boxes, Link2, Sparkles } from 'lucide-react';
import { useAppStore, type CapabilityHubTab } from '../../../stores/appStore';
import { useAuthStore } from '../../../stores/authStore';
import { useI18n } from '../../../hooks/useI18n';
import { createAccessSubject } from '../../../utils/accessControl';
import { canAccessSettingsTab } from '../../../utils/settingsTabs';
import { FullScreenPage } from '../shared/FullScreenPage';
import { PageContent } from '../shared/PageContent';
import { ExpertPanel } from '../expert/ExpertPanel';

// 四个重型 tab 一律懒加载：能力中心比设置页开得频繁得多，
// 首屏不该背着技能/连接器/插件/能力清单的注册表。
const SkillsSettings = React.lazy(() => import('../settings/tabs/SkillsSettings').then((m) => ({ default: m.SkillsSettings })));
const MCPSettings = React.lazy(() => import('../settings/tabs/MCPSettings').then((m) => ({ default: m.MCPSettings })));
const PluginsSettings = React.lazy(() => import('../settings/tabs/PluginsSettings').then((m) => ({ default: m.PluginsSettings })));

const HUB_TABS: Array<{ key: CapabilityHubTab; icon: React.ReactNode; label: (t: ReturnType<typeof useI18n>['t']) => string }> = [
  { key: 'experts', icon: <Boxes className="h-4 w-4" />, label: (t) => t.capabilityHub.tabExperts },
  { key: 'skills', icon: <Sparkles className="h-4 w-4" />, label: (t) => t.capabilityHub.tabSkills },
  { key: 'connectors', icon: <Link2 className="h-4 w-4" />, label: (t) => t.capabilityHub.tabConnectors },
  { key: 'plugins', icon: <Blocks className="h-4 w-4" />, label: (t) => t.capabilityHub.tabPlugins },
];

export const CapabilityHubPage: React.FC = () => {
  const { t } = useI18n();
  const currentUser = useAuthStore((s) => s.user);
  const accessSubject = useMemo(() => createAccessSubject(currentUser), [currentUser]);
  const { capabilityHubTab, openCapabilityHub } = useAppStore();
  // 「插件」tab 仅管理员可见（E5，2026-07-27 拍板；#751 曾无条件下架，此处按工单
  // 收敛为 access 门控：普通用户不渲染入口，admin 保留可达路径）。深链常量保留，
  // 指向 plugins 的深链由下方 useEffect 兜底回退到第一个可见 tab，不崩不白屏。
  const visibleTabs = useMemo(() => HUB_TABS.filter(({ key }) => (
    key !== 'plugins' || canAccessSettingsTab('plugins', accessSubject)
  )), [accessSubject]);
  useEffect(() => {
    if (visibleTabs.some((tab) => tab.key === capabilityHubTab)) return;
    openCapabilityHub(visibleTabs[0].key);
  }, [capabilityHubTab, openCapabilityHub, visibleTabs]);

  const content = capabilityHubTab === 'experts' ? <ExpertPanel />
    : capabilityHubTab === 'skills' ? <SkillsSettings />
    : capabilityHubTab === 'connectors' ? <MCPSettings />
    : capabilityHubTab === 'plugins' && canAccessSettingsTab('plugins', accessSubject) ? <PluginsSettings />
    : null;

  const activeTabLabel = (visibleTabs.find((tab) => tab.key === capabilityHubTab) ?? visibleTabs[0]).label(t);

  return (
    <FullScreenPage testId="capability-hub-page" variant="inline">
      {/* 2026-07-27 审美关拍板（对标 WorkBuddy）：四个 tab 从右上角小胶囊提为顶行主导航，
          页面大标题跟着当前 tab 走——「能力中心」是容器名，用户真正在看的是「专家 / 技能 / …」。
          分类筛选留给各 tab 自己在内容区顶部铺（专家 tab 的 chips 带人数）。 */}
      <header className="shrink-0 px-6 pt-4">
        <div className="flex items-center gap-3">
          <nav className="flex items-center gap-1" role="tablist" aria-label={t.capabilityHub.title}>
            {visibleTabs.map(({ key, icon, label }) => (
              <button /* ds-allow:button: 能力中心主导航 pill（role=tab，图标+文案左对齐），Button primitive 无 tab 语义变体 */
                key={key}
                type="button"
                role="tab"
                aria-selected={capabilityHubTab === key}
                data-testid={`capability-hub-tab-${key}`}
                onClick={() => openCapabilityHub(key)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                  capabilityHubTab === key
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300'
                }`}
              >
                {icon}
                {label(t)}
              </button>
            ))}
          </nav>
        </div>
        <h1 className="mt-4 truncate text-2xl font-semibold tracking-tight text-zinc-100">{activeTabLabel}</h1>
      </header>
      {/* 内容区走 PageContent 契约（全宽 + px-6 py-4），pb-12 保留底部呼吸位 */}
      <PageContent className="pb-12">
        <React.Suspense fallback={<div className="p-4 text-sm text-zinc-500">{t.settings.modal.loading}</div>}>
          {content}
        </React.Suspense>
      </PageContent>
    </FullScreenPage>
  );
};
