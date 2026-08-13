// ============================================================================
// Orchestrator Run Settings - Runtime configuration state and loop forwarding
// ============================================================================

import type { EffortLevel, InteractionMode } from '../../shared/contract/agent';
import type { ResearchUserSettings } from '../research/types';
import type { AgentLoop } from './agentLoop';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('AgentOrchestrator');

/** 承载运行配置面板的状态，保留原有日志与 AgentLoop 调用时机。 */
export class OrchestratorRunSettings {
  private researchUserSettings: Partial<ResearchUserSettings> = {
    autoDetect: true,
    confirmBeforeStart: false,
  };
  private delegateMode = false;
  private requirePlanApproval = false;

  constructor(private readonly getAgentLoop: () => AgentLoop | null) {}

  setResearchUserSettings(settings: Partial<ResearchUserSettings>): void {
    this.researchUserSettings = { ...this.researchUserSettings, ...settings };
    logger.debug('Research user settings updated:', this.researchUserSettings);
  }

  getResearchUserSettings(): Partial<ResearchUserSettings> {
    return { ...this.researchUserSettings };
  }

  setDelegateMode(enabled: boolean): void {
    this.delegateMode = enabled;
    logger.info(`[AgentOrchestrator] Delegate mode ${enabled ? 'enabled' : 'disabled'}`);
  }

  isDelegateMode(): boolean {
    return this.delegateMode;
  }

  setEffortLevel(level: EffortLevel): void {
    this.getAgentLoop()?.setEffortLevel(level);
    logger.info(`[AgentOrchestrator] Effort level set to ${level}`);
  }

  setThinkingEnabled(enabled: boolean): void {
    this.getAgentLoop()?.setThinkingEnabled(enabled);
    logger.info(`[AgentOrchestrator] Thinking ${enabled ? 'enabled' : 'disabled'}`);
  }

  setInteractionMode(mode: InteractionMode): void {
    this.getAgentLoop()?.setInteractionMode(mode);
    logger.info(`[AgentOrchestrator] Interaction mode set to ${mode}`);
  }

  setRequirePlanApproval(enabled: boolean): void {
    this.requirePlanApproval = enabled;
    logger.info(`[AgentOrchestrator] Plan approval ${enabled ? 'required' : 'not required'}`);
  }

  isRequirePlanApproval(): boolean {
    return this.requirePlanApproval;
  }
}
