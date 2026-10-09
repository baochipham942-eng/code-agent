// Skill install caution disclosure. Types only — part B (renderer) imports these.
// Host policy lives next to the install scanner; this file must not import host.

export interface SkillInstallCautionHit {
  file: string;
  ruleId: string;
  snippet: string;
}

export interface SkillCautionConfirmationRequired {
  success: false;
  code: 'SKILL_CAUTION_CONFIRMATION_REQUIRED';
  pluginSpec: string;
  sourceTrust: 'official-registry' | 'unsigned-github-archive' | 'local-marketplace' | 'builtin';
  cautionHits: SkillInstallCautionHit[];
  confirmationToken: string;
  /**
   * Marketplace install IPC is a union with PluginInstallResult. The renderer
   * reads `result?.cancelled` on every member, so the field has to exist here
   * even though this result is never a cancellation.
   */
  cancelled?: boolean;
}
