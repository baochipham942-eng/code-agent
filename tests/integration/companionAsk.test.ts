import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../src/host/agent/teammate/teammateService', () => ({
  getTeammateService: () => ({ sendPlanReview: vi.fn(), approvePlan: vi.fn(), rejectPlan: vi.fn() }),
}));
vi.mock('../../src/host/services/eventing/bus', () => ({
  getEventBus: () => ({ publish: vi.fn() }),
}));
vi.mock('../../src/host/services/infra/notificationService', () => ({ notificationService: { notifyNeedsInput: vi.fn() } }));

import Database from 'better-sqlite3';
import { CompanionGateway } from '../../src/host/services/companion/CompanionGateway';
import { CompanionQuestionService } from '../../src/host/services/companion/CompanionQuestionService';
import { CompanionPlanService } from '../../src/host/services/companion/CompanionPlanService';
import { PlanApprovalGate } from '../../src/host/agent/planApproval';
import {
  registerUserQuestionRoute,
  canOfferRegisteredUserQuestion,
  offerRegisteredUserQuestion,
  cancelRegisteredUserQuestion,
} from '../../src/host/services/capabilities/hostCapabilityPorts';
import type { CompanionCommand } from '../../src/shared/contract/companion';
import type { UserQuestionRequest, UserQuestionResponse } from '../../src/shared/contract';
import type { SwarmRunScope } from '../../src/shared/contract/swarm';

const sessionId = 'ask-session';
const questionRequest: UserQuestionRequest = {
  id: 'q-1',
  sessionId,
  timestamp: 1,
  questions: [{
    question: '用哪个方向？',
    header: '方向',
    options: [
      { label: '继续', description: '按原计划' },
      { label: '停止', description: '先停下' },
    ],
  }],
};

const scope: SwarmRunScope = { sessionId, runId: 'run-1', treeId: 'tree-1' };

describe('companion question and plan cards use the desktop decision points', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;
  let questions: CompanionQuestionService;
  let plans: CompanionPlanService;
  let gate: PlanApprovalGate;
  let cleanupQuestion: () => void;

  beforeEach(() => {
    db = new Database(':memory:');
    gate = new PlanApprovalGate({ approvalTimeoutMs: 30_000 });
    gateway = new CompanionGateway(db, {
      refreshDecisions: () => { questions.refresh(); plans.refresh(); },
      decide: command => {
        if (command.action === 'question.respond') return questions.respond(command);
        if (command.action === 'plan.respond') return plans.respond(command);
        return { kind: 'rejected', reason: 'unsupported_action' };
      },
    });
    questions = new CompanionQuestionService(gateway);
    plans = new CompanionPlanService(gateway, () => gate.getPendingPlans().flatMap(plan => {
      const id = plan.scope?.sessionId;
      if (!id) return [];
      return [{ id: plan.id, sessionId: id, plan: plan.plan, agentName: plan.agentName, risk: plan.risk }];
    }), (planId, approved, feedback, expectedSession) => {
      const plan = gate.getPlan(planId);
      if (!plan || plan.status !== 'pending' || plan.scope?.sessionId !== expectedSession) {
        return { success: false, data: { closed: true } };
      }
      const ok = approved ? gate.approve(planId, feedback) : gate.reject(planId, feedback ?? 'Rejected');
      return { success: ok };
    });
    cleanupQuestion = registerUserQuestionRoute(questions);
    gateway.registerDevice({ deviceId: 'phone', credentialHash: 'hash', scope: [sessionId], scopeEpoch: 1, revokedAt: null });
    gateway.registerDevice({ deviceId: 'phone-two', credentialHash: 'hash-two', scope: [sessionId], scopeEpoch: 1, revokedAt: null });
  });
  afterEach(() => { cleanupQuestion(); db.close(); });

  it('question projection appears, phone respond settles the desktop pending map', async () => {
    let settled: UserQuestionResponse | undefined;
    expect(questions.offer(questionRequest, response => { settled = response; })).toBe(true);
    const event = gateway.syncForDevice('phone', 1, 0).events.find(item => item.kind === 'question');
    expect(event?.payload.preview).toContain('用哪个方向？');
    const card = gateway.getDecision('q-1')!;
    const command: Extract<CompanionCommand, { action: 'question.respond' }> = {
      version: 1, deviceId: 'phone', scopeEpoch: 1, commandId: 'q-cmd-1', sessionId,
      action: 'question.respond', expectedRevision: card.revision,
      payload: { requestId: 'q-1', operationDigest: card.operationDigest!, answers: { 方向: '继续' } },
    };
    expect(gateway.submit(command).kind).toBe('accepted');
    expect(settled).toEqual({ requestId: 'q-1', answers: { 方向: '继续' } });
    expect(gateway.getDecision('q-1')).toMatchObject({ status: 'approved', resolvedBy: 'phone' });
    expect(gateway.submit({ ...command, commandId: 'q-cmd-2' }).kind).toBe('approval_conflict');
  });

  it('plan projection appears, phone respond releases PlanApprovalGate pendingResolvers', async () => {
    vi.useFakeTimers();
    const pending = gate.submitForApproval({
      agentId: 'agent-1', agentName: 'Coder', coordinatorId: 'coord',
      plan: '1. Read host\n2. Write the card', risk: { level: 'medium', reasons: ['Dangerous command: rm'] },
      scope,
    });
    await vi.advanceTimersByTimeAsync(0);
    plans.refresh();
    const event = gateway.syncForDevice('phone', 1, 0).events.find(item => item.kind === 'plan');
    expect(event?.payload.preview).toContain('Write the card');
    const planId = gate.getPendingPlans(scope)[0].id;
    const card = gateway.getDecision(planId)!;
    const command: Extract<CompanionCommand, { action: 'plan.respond' }> = {
      version: 1, deviceId: 'phone', scopeEpoch: 1, commandId: 'p-cmd-1', sessionId,
      action: 'plan.respond', expectedRevision: card.revision,
      payload: { requestId: planId, operationDigest: card.operationDigest!, decision: 'approved', feedback: 'go' },
    };
    expect(gateway.submit(command).kind).toBe('accepted');
    await expect(pending).resolves.toMatchObject({ approved: true, feedback: 'go', autoApproved: false });
    expect(gate.getPendingPlans()).toEqual([]);
    vi.useRealTimers();
  });

  it('a second command ID cannot redispatch a question whose first outcome is unknown', () => {
    questions.offer(questionRequest, () => {});
    const card = gateway.getDecision('q-1')!;
    const decide = vi.fn(() => { throw new Error('side effect outcome unknown'); });
    const racing = new CompanionGateway(db, { decide });
    racing.registerDevice({ deviceId: 'phone', credentialHash: 'hash', scope: [sessionId], scopeEpoch: 1, revokedAt: null });
    const command: Extract<CompanionCommand, { action: 'question.respond' }> = {
      version: 1, deviceId: 'phone', scopeEpoch: 1, commandId: 'q-unknown-1', sessionId,
      action: 'question.respond', expectedRevision: card.revision,
      payload: { requestId: 'q-1', operationDigest: card.operationDigest!, answers: { 方向: '继续' } },
    };
    expect(racing.submit(command).kind).toBe('replayed');
    expect(racing.submit({ ...command, commandId: 'q-unknown-2' })).toMatchObject({ kind: 'replayed', command: { state: 'reconciling' } });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_decision_claims').get()).toEqual({ n: 1 });
  });

  it('two phones racing the same question: only the first CAS claim settles the decision point', () => {
    let calls = 0;
    questions.offer(questionRequest, () => { calls += 1; });
    const card = gateway.getDecision('q-1')!;
    const base = {
      version: 1 as const, scopeEpoch: 1, sessionId, action: 'question.respond' as const,
      expectedRevision: card.revision,
      payload: { requestId: 'q-1', operationDigest: card.operationDigest!, answers: { 方向: '继续' } },
    };
    expect(gateway.submit({ ...base, deviceId: 'phone', commandId: 'first' }).kind).toBe('accepted');
    expect(gateway.submit({ ...base, deviceId: 'phone-two', commandId: 'second' }).kind).toBe('approval_conflict');
    expect(calls).toBe(1);
  });

  it('two phones racing the same plan: only the first CAS claim approves the gate', async () => {
    vi.useFakeTimers();
    const pending = gate.submitForApproval({
      agentId: 'agent-1', agentName: 'Coder', coordinatorId: 'coord',
      plan: 'delete build cache', risk: { level: 'high', reasons: ['File deletion command'] },
      scope,
    });
    await vi.advanceTimersByTimeAsync(0);
    plans.refresh();
    const planId = gate.getPendingPlans(scope)[0].id;
    const card = gateway.getDecision(planId)!;
    const base = {
      version: 1 as const, scopeEpoch: 1, sessionId, action: 'plan.respond' as const,
      expectedRevision: card.revision,
      payload: { requestId: planId, operationDigest: card.operationDigest!, decision: 'approved' as const },
    };
    expect(gateway.submit({ ...base, deviceId: 'phone', commandId: 'plan-first' }).kind).toBe('accepted');
    expect(gateway.submit({ ...base, deviceId: 'phone-two', commandId: 'plan-second' }).kind).toBe('approval_conflict');
    await expect(pending).resolves.toMatchObject({ approved: true });
    vi.useRealTimers();
  });

  it('revoked device cannot respond to a live question', () => {
    questions.offer(questionRequest, () => {});
    const card = gateway.getDecision('q-1')!;
    gateway.revokeDevice('phone', 2_000);
    expect(gateway.submit({
      version: 1, deviceId: 'phone', scopeEpoch: 2, commandId: 'revoked', sessionId,
      action: 'question.respond', expectedRevision: card.revision,
      payload: { requestId: 'q-1', operationDigest: card.operationDigest!, answers: { 方向: '继续' } },
    }).kind).toBe('rejected');
  });

  it('wrong session scope is rejected before the decision point is touched', () => {
    questions.offer(questionRequest, () => {});
    const card = gateway.getDecision('q-1')!;
    expect(gateway.submit({
      version: 1, deviceId: 'phone', scopeEpoch: 1, commandId: 'wrong-scope', sessionId: 'unshared',
      action: 'question.respond', expectedRevision: card.revision,
      payload: { requestId: 'q-1', operationDigest: card.operationDigest!, answers: { 方向: '继续' } },
    })).toMatchObject({ kind: 'rejected', reason: 'scope_denied' });
    expect(gateway.getDecision('q-1')).toMatchObject({ status: 'pending' });
  });

  it('an expired plan request is rejected and does not resurrect the resolver', async () => {
    vi.useFakeTimers();
    const pending = gate.submitForApproval({
      agentId: 'agent-1', agentName: 'Coder', coordinatorId: 'coord',
      plan: 'wipe tmp', risk: { level: 'medium', reasons: ['Dangerous command: rm'] },
      scope,
    });
    await vi.advanceTimersByTimeAsync(0);
    plans.refresh();
    const planId = gate.getPendingPlans(scope)[0].id;
    const card = gateway.getDecision(planId)!;
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(pending).resolves.toMatchObject({ approved: false, autoApproved: true });
    plans.refresh();
    expect(gateway.submit({
      version: 1, deviceId: 'phone', scopeEpoch: 1, commandId: 'expired', sessionId,
      action: 'plan.respond', expectedRevision: card.revision,
      payload: { requestId: planId, operationDigest: card.operationDigest!, decision: 'approved' },
    }).kind).toBe('approval_conflict');
    vi.useRealTimers();
  });

  it('voice-bridge registration and companion registration coexist without squeezing each other', () => {
    const voiceOffered: string[] = [];
    const cleanupVoice = registerUserQuestionRoute({
      canOffer: id => id === sessionId,
      offer: (request, _respond) => { voiceOffered.push(request.id); return true; },
      cancel: () => {},
    });
    try {
      expect(canOfferRegisteredUserQuestion(sessionId)).toBe(true);
      expect(offerRegisteredUserQuestion(questionRequest, () => {})).toBe(true);
      expect(voiceOffered).toEqual(['q-1']);
      expect(gateway.getDecision('q-1')).toMatchObject({ status: 'pending', kind: 'question' });
      cancelRegisteredUserQuestion('q-1');
      expect(gateway.getDecision('q-1')).toMatchObject({ status: 'closed' });
    } finally {
      cleanupVoice();
    }
  });

  it('companion still receives questions when the voice bridge is registered but not bound', () => {
    const cleanupVoice = registerUserQuestionRoute({
      canOffer: () => false,
      offer: () => false,
      cancel: () => {},
    });
    try {
      expect(canOfferRegisteredUserQuestion(sessionId)).toBe(true);
      expect(questions.offer(questionRequest, () => {})).toBe(true);
      expect(gateway.syncForDevice('phone', 1, 0).events.some(event => event.kind === 'question')).toBe(true);
    } finally {
      cleanupVoice();
    }
  });
});
