import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSurfaceConversationSnapshotV1 } from '../../../src/shared/contract/surfaceExecution';
import { buildSurfaceExecutionProjectionV1 } from '../../../src/renderer/utils/surfaceExecutionProjection';
import {
  buildConversationExecutionSnapshot,
  CONVERSATION_EXECUTION_CANARY,
  transitionConversationExecutionSnapshot,
} from '../../../scripts/acceptance/fixtures/surface-execution-conversation';

describe('Surface Execution Conversation acceptance fixture', () => {
  it('routes the app-host acceptance through the production Surface runtime and domain API', () => {
    const source = readFileSync(resolve(
      process.cwd(),
      'scripts/acceptance/surface-execution-conversation-smoke.ts',
    ), 'utf8');

    expect(source).toContain("fetch('/api/dev/surface-execution-conversation/seed'");
    expect(source).toContain("item.domain === 'domain:surfaceExecution'");
    expect(source).toContain("item.action === 'control'");
    expect(source).toContain("item.action === 'getFrame'");
    expect(source).toContain("'production_frame_resolution_chain'");
    expect(source).toContain("'runtime_session_store_domain_renderer_chain'");
    expect(source).toContain("'cross_surface_switch_reason_displayed'");
    expect(source).not.toContain("page.route('**/api/domain/surfaceExecution/**'");
    expect(source).not.toContain('transitionConversationExecutionSnapshot(');

    const seedRoute = readFileSync(resolve(
      process.cwd(),
      'src/web/routes/devSurfaceExecutionConversation.ts',
    ), 'utf8');
    expect(seedRoute).toContain("action: 'surface_switch'");
    expect(seedRoute).toContain('因为最终产物需要页面截图复验，已从 Computer 返回 Browser');
  });

  it('builds a native writable snapshot with evidence, outputs and redacted semantic events', () => {
    const snapshot = buildConversationExecutionSnapshot({
      conversationId: 'conversation-acceptance',
      evidenceAssetRef: '/tmp/conversation-evidence.png',
      now: 10_000,
    });

    expect(isSurfaceConversationSnapshotV1(snapshot)).toBe(true);
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({
      source: 'live',
      writable: true,
      availableControls: ['pause', 'takeover', 'stop', 'end_session'],
      evidence: [{
        kind: 'screenshot',
        inspection: {
          captureState: 'captured',
          analysisState: 'analyzed',
          verificationState: 'verified',
        },
      }],
    });
    expect(snapshot.sessions[0]?.outputs.map((output) => output.label)).toEqual([
      'travel-site-final.html',
      'travel-site-final.png',
      'conversation-execution-proof.json',
    ]);

    const projection = buildSurfaceExecutionProjectionV1({
      conversationId: snapshot.conversationId,
      nativeSnapshot: snapshot,
    });
    const serialized = JSON.stringify(projection);
    expect(projection.mode).toBe('native');
    expect(serialized).not.toContain(CONVERSATION_EXECUTION_CANARY);
    expect(serialized).toContain('[redacted-canary]');
  });

  it('drives the exact Pause, Resume, Takeover and Stop view states', () => {
    const initial = buildConversationExecutionSnapshot({
      conversationId: 'conversation-controls',
      evidenceAssetRef: '/tmp/conversation-evidence.png',
      now: 10_000,
    });
    const paused = transitionConversationExecutionSnapshot(initial, 'pause', 11_000);
    const resumed = transitionConversationExecutionSnapshot(paused, 'resume', 12_000);
    const takeover = transitionConversationExecutionSnapshot(resumed, 'takeover', 13_000);
    const continued = transitionConversationExecutionSnapshot(takeover, 'resume', 14_000);
    const stopping = transitionConversationExecutionSnapshot(continued, 'stop', 15_000);

    expect(paused.sessions[0]).toMatchObject({
      session: { state: 'paused' },
      availableControls: ['resume', 'takeover', 'stop', 'end_session'],
    });
    expect(resumed.sessions[0]?.session.state).toBe('running');
    expect(takeover.sessions[0]).toMatchObject({
      session: { state: 'waiting_human' },
      availableControls: ['resume', 'stop', 'end_session'],
    });
    expect(stopping.sessions[0]).toMatchObject({
      session: { state: 'stopping' },
      availableControls: ['end_session'],
    });
    expect(stopping.sessions[0]?.events.map((event) => event.phase).slice(-5)).toEqual([
      'human',
      'recover',
      'human',
      'recover',
      'cleanup',
    ]);
  });
});
