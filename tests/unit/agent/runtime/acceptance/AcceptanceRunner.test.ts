import { describe, expect, it, vi } from 'vitest';
import { runScenarioAcceptance } from '../../../../../src/main/agent/runtime/acceptance/AcceptanceRunner';

describe('runScenarioAcceptance', () => {
  it('reports frontend layout issues with repair instructions and preview anchors', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const result = runScenarioAcceptance({
      sessionId: 'session-1',
      selectedSkillIds: ['frontend_ui'],
      artifacts: [
        {
          id: 'artifact-html',
          kind: 'generic_html',
          title: 'Landing Draft',
          filePath: '/tmp/landing.html',
          content: {
            html: '<html><body><main style="width: 1440px">Draft</main></body></html>',
          },
        },
      ],
    });

    expect(result.id).toBe('delivery-review:session-1:1000');
    expect(result.status).toBe('needs_work');
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'missing_viewport',
      'layout_overflow',
      'weak_responsive_layout',
    ]);
    expect(result.issues[1]).toMatchObject({
      severity: 'error',
      anchor: {
        kind: 'text_quote',
        filePath: '/tmp/landing.html',
        quote: 'width: 1440px',
      },
    });
    expect(result.issues[1].repairInstruction).toMatch(/responsive/i);
    vi.restoreAllMocks();
  });

  it('reuses game repair issue codes for generated games', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000);
    const result = runScenarioAcceptance({
      sessionId: 'session-game',
      selectedSkillIds: ['game_generation'],
      artifacts: [
        {
          id: 'game-html',
          kind: 'generic_html',
          title: 'Generated game',
          content: {
            html: '<script>window.__GAME_META__ = { subtype: "platformer" };</script>',
          },
        },
      ],
    });

    expect(result.status).toBe('needs_work');
    expect(result.issues.some((issue) => issue.code === 'missing_test_contract')).toBe(true);
    expect(result.skills.map((skill) => skill.id)).toEqual(['game_generation']);
    vi.restoreAllMocks();
  });

  it('blocks unsafe production deployment handoffs', () => {
    const result = runScenarioAcceptance({
      sessionId: 'session-deploy',
      selectedSkillIds: ['deployment_share'],
      artifacts: [
        {
          id: 'deploy-note',
          kind: 'message_draft',
          title: 'Deploy note',
          content: {
            text: 'Please deploy this to production today.',
          },
        },
      ],
    });

    expect(result.status).toBe('blocked');
    expect(result.issues.map((issue) => issue.code)).toContain('unsafe_deploy_target');
  });
});
