// ============================================================================
// AgentEngineSettings - Agent 引擎设置 Tab
//
// 外部 CLI Agent 引擎（Codex CLI / Claude Code）的模型偏好配置。
// 从模型设置页拆出为独立 tab：API Provider（模型页）和外部引擎是两个概念，
// 混在一页加重信息密度（Master-Detail 重构 stage 2）。
// ============================================================================

import React from 'react';
import { SettingsPage } from '../SettingsLayout';
import { WebModeBanner } from '../WebModeBanner';
import { AgentEngineModelCatalogSection } from './AgentEngineModelCatalogSection';

export const AgentEngineSettings: React.FC = () => (
  <SettingsPage
    title="Agent 引擎"
    description="管理外部 CLI Agent 引擎（Codex CLI / Claude Code）的安装状态与默认模型。引擎在聊天输入框的引擎切换器中选用。"
  >
    <WebModeBanner />
    <AgentEngineModelCatalogSection />
  </SettingsPage>
);
