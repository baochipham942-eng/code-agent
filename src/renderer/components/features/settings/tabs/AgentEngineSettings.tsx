// ============================================================================
// AgentEngineSettings - Agent 引擎设置 Tab
//
// 外部 CLI Agent 引擎（Codex CLI / Claude Code）的模型偏好配置。
// 从模型设置页拆出为独立 tab：API Provider（模型页）和外部引擎是两个概念，
// 混在一页加重信息密度（Master-Detail 重构 stage 2）。
// ============================================================================

import React from 'react';
import { useI18n } from '../../../../hooks/useI18n';
import { SettingsPage } from '../SettingsLayout';
import { WebModeBanner } from '../WebModeBanner';
import { AgentEngineListSection } from './AgentEngineListSection';
import { AgentEngineModelCatalogSection } from './AgentEngineModelCatalogSection';

export const AgentEngineSettings: React.FC = () => {
  const { t } = useI18n();
  return (
    <SettingsPage
      title={t.engineCompat.engineSection.title}
      description={t.engineCompat.engineSection.description}
    >
      <WebModeBanner />
      <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60 px-4 py-3">
        <div className="text-sm font-medium text-zinc-100">{t.engineCompat.engineSection.guide.title}</div>
        <p className="mt-1 text-xs leading-5 text-zinc-400">
          {t.engineCompat.engineSection.guide.body}
        </p>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          {t.engineCompat.engineSection.guide.items.map((item) => (
            <div key={item.title} className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2">
              <div className="text-xs font-medium text-zinc-200">{item.title}</div>
              <div className="mt-1 text-[11px] leading-4 text-zinc-500">{item.description}</div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] leading-4 text-zinc-500">
          {t.engineCompat.engineSection.guide.switchHint}
        </p>
      </div>
      <AgentEngineListSection />
      <AgentEngineModelCatalogSection />
    </SettingsPage>
  );
};
