import React, { useEffect, useMemo } from 'react';
import { Boxes } from 'lucide-react';
import { useAppStore, type CapabilityHubTab } from '../../../stores/appStore';
import { useAuthStore } from '../../../stores/authStore';
import { useI18n } from '../../../hooks/useI18n';
import { createAccessSubject } from '../../../utils/accessControl';
import { canAccessSettingsTab } from '../../../utils/settingsTabs';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';
import { ExpertPanel } from '../expert/ExpertPanel';

// 四个重型 tab 一律懒加载：能力中心比设置页开得频繁得多，
// 首屏不该背着技能/连接器/插件/能力清单的注册表。
const SkillsSettings = React.lazy(() => import('../settings/tabs/SkillsSettings').then((m) => ({ default: m.SkillsSettings })));
const MCPSettings = React.lazy(() => import('../settings/tabs/MCPSettings').then((m) => ({ default: m.MCPSettings })));
const PluginsSettings = React.lazy(() => import('../settings/tabs/PluginsSettings').then((m) => ({ default: m.PluginsSettings })));

const HUB_TABS: Array<{ key: CapabilityHubTab; label: (t: ReturnType<typeof useI18n>['t']) => string }> = [
  { key: 'experts', label: (t) => t.capabilityHub.tabExperts },
  { key: 'skills', label: (t) => t.capabilityHub.tabSkills },
  { key: 'connectors', label: (t) => t.capabilityHub.tabConnectors },
  { key: 'plugins', label: (t) => t.capabilityHub.tabPlugins },
];

export const CapabilityHubPage: React.FC = () => {
  const { t } = useI18n();
  const currentUser = useAuthStore((s) => s.user);
  const accessSubject = useMemo(() => createAccessSubject(currentUser), [currentUser]);
  const { capabilityHubTab, openCapabilityHub, setShowCapabilityHub } = useAppStore();
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

  return (
    <FullScreenPage testId="capability-hub-page">
      <FullScreenPageHeader
        icon={<Boxes className="h-4 w-4 text-violet-300" />}
        title={t.capabilityHub.title}
        description={t.capabilityHub.description}
        onClose={() => setShowCapabilityHub(false)}
        closeLabel={t.common.close}
        actions={(
          <div className="flex rounded-md border border-zinc-700 p-0.5" role="tablist">
            {visibleTabs.map(({ key, label }) => (
              <button /* ds-allow:button: 能力中心 tab 切换胶囊（role=tab 分段控件），Button primitive 无 tab 语义变体 */ key={key} type="button" role="tab" aria-selected={capabilityHubTab === key} data-testid={`capability-hub-tab-${key}`} onClick={() => openCapabilityHub(key)} className={`rounded px-2.5 py-1 text-xs transition-colors ${capabilityHubTab === key ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}>
                {label(t)}
              </button>
            ))}
          </div>
        )}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-12 pt-4">
        <React.Suspense fallback={<div className="p-4 text-sm text-zinc-500">{t.settings.modal.loading}</div>}>
          {content}
        </React.Suspense>
      </div>
    </FullScreenPage>
  );
};
