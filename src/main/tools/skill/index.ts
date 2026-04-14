// ============================================================================
// Skill Tool - Agent Skills Standard
// ============================================================================

// skillMetaTool moved to agent/skillTools/skillMetaTool.ts
// Re-export preserved for back-compat with any consumer of tools/skill barrel.
export {
  skillMetaTool,
  getSkillToolDescription,
} from '../../agent/skillTools/skillMetaTool';
export { skillCreateTool } from './skillCreateTool';
