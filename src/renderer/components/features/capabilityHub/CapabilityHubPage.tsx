import React, { useEffect, useMemo } from 'react';
import { Boxes, ScrollText } from 'lucide-react';
import { useAppStore, type CapabilityHubTab } from '../../../stores/appStore';
import { useAuthStore } from '../../../stores/authStore';
import { useI18n } from '../../../hooks/useI18n';
import { canAccessFeature, createAccessSubject } from '../../../utils/accessControl';
import { canAccessSettingsTab } from '../../../utils/settingsTabs';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';
import { PageContent } from '../shared/PageContent';
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
  const { capabilityHubTab, openCapabilityHub, setShowCapabilityHub, setShowPromptManager } = useAppStore();
  const visibleTabs = useMemo(() => HUB_TABS.filter(({ key }) => (
    key !== 'plugins' || canAccessSettingsTab('plugins', accessSubject)
  )), [accessSubject]);
  // 提示词管理（admin-only）收进能力中心 header（2026-07 方案 9C：从用户菜单迁来）
  const canOpenPromptManager = canAccessFeature('prompt.manager', accessSubject);

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
        actions={(
          <div className="flex items-center gap-2">
            {canOpenPromptManager && (
              <button /* ds-allow:button: 能力中心 header 提示词入口，对齐 tab 胶囊的 12px 微尺寸行内样式，Button primitive 无对应变体 */ type="button" data-testid="capability-hub-open-prompts" onClick={() => setShowPromptManager(true)} className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 transition-colors hover:text-zinc-200">
                <ScrollText className="h-3.5 w-3.5" />
                {t.capabilityHub.openPromptManager}
              </button>
            )}
            <div className="flex rounded-md border border-zinc-700 p-0.5" role="tablist">
              {visibleTabs.map(({ key, label }) => (
                <button /* ds-allow:button: 能力中心 tab 切换胶囊（role=tab 分段控件），Button primitive 无 tab 语义变体 */ key={key} type="button" role="tab" aria-selected={capabilityHubTab === key} data-testid={`capability-hub-tab-${key}`} onClick={() => openCapabilityHub(key)} className={`rounded px-2.5 py-1 text-xs transition-colors ${capabilityHubTab === key ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}>
                  {label(t)}
                </button>
              ))}
            </div>
          </div>
        )}
      />
      {/* 内容区走 PageContent 契约（全宽 + px-6 py-4），pb-12 保留底部呼吸位 */}
      <PageContent className="pb-12">
        <React.Suspense fallback={<div className="p-4 text-sm text-zinc-500">{t.settings.modal.loading}</div>}>
          {content}
        </React.Suspense>
      </PageContent>
    </FullScreenPage>
  );
};
