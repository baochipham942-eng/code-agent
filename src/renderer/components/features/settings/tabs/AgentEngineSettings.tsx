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
      <AgentEngineListSection />
      <AgentEngineModelCatalogSection />
    </SettingsPage>
  );
};
