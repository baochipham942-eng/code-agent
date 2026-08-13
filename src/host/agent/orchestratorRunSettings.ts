// ============================================================================
// Orchestrator Run Settings - Runtime configuration state and loop forwarding
// ============================================================================

import type { ResearchUserSettings } from '../research/types';
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

  constructor() {}

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

  setRequirePlanApproval(enabled: boolean): void {
    this.requirePlanApproval = enabled;
    logger.info(`[AgentOrchestrator] Plan approval ${enabled ? 'required' : 'not required'}`);
  }

  isRequirePlanApproval(): boolean {
    return this.requirePlanApproval;
  }
}
