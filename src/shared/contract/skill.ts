// ============================================================================
// Skill Types (for Gen 4)
// ============================================================================

export interface SkillDefinition {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  args?: string[];
}
