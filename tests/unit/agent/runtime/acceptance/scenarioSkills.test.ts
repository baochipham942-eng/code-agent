import { describe, expect, it } from 'vitest';
import {
  inferScenarioAcceptanceSkillIds,
  listScenarioAcceptanceSkills,
} from '../../../../../src/main/agent/runtime/acceptance/scenarioSkills';

describe('scenario acceptance skills', () => {
  it('lists the six built-in scenario skills', () => {
    expect(listScenarioAcceptanceSkills().map((skill) => skill.id).sort()).toEqual([
      'admin_console',
      'deployment_share',
      'document_report',
      'frontend_ui',
      'game_generation',
      'research_evidence',
    ]);
  });

  it('infers admin_console for dashboard-like HTML artifacts', () => {
    const ids = inferScenarioAcceptanceSkillIds([
      {
        id: 'preview-1',
        kind: 'generic_html',
        title: 'Admin dashboard',
        content: { html: '<main><table><tr><td>Status</td></tr></table></main>' },
      },
    ]);

    expect(ids).toContain('admin_console');
    expect(ids).not.toContain('frontend_ui');
  });

  it('infers game_generation when game metadata is present', () => {
    const ids = inferScenarioAcceptanceSkillIds([
      {
        id: 'game-1',
        kind: 'generic_html',
        title: 'Platformer',
        content: { html: '<script>window.__GAME_META__ = { subtype: "platformer" };</script>' },
      },
    ]);

    expect(ids).toContain('game_generation');
  });
});
