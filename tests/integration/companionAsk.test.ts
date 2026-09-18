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
import { CompanionPlanService, inspectionFromGatePlan } from '../../src/host/services/companion/CompanionPlanService';
import { PlanApprovalGate } from '../../src/host/agent/planApproval';
import { PendingApprovalRepository } from '../../src/host/services/core/repositories/PendingApprovalRepository';
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
    }, planId => {
      // 与 src/web/app.ts 的 inspectCompanionPlan 同款：结算判定走真分类器
      // inspectionFromGatePlan（结构化 resolutionOrigin），不在这里复制判据。
      const plan = gate.getPlan(planId);
      return plan ? inspectionFromGatePlan(plan) : null;
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
    expect((await gateway.submit(command)).kind).toBe('accepted');
    expect(settled).toEqual({ requestId: 'q-1', answers: { 方向: '继续' } });
    expect(gateway.getDecision('q-1')).toMatchObject({
      status: 'approved', resolvedBy: 'phone', outcome: 'answered', answer: { answers: { 方向: '继续' } },
    });
    expect((await gateway.submit({ ...command, commandId: 'q-cmd-2' })).kind).toBe('approval_conflict');
  });

  it('desktop answers publish outcome=answered with the chosen option, not a bare closed', () => {
    questions.offer(questionRequest, () => {});
    cancelRegisteredUserQuestion('q-1', { outcome: 'answered', answer: { answers: { 方向: '品牌与市场团队' } } });
    expect(gateway.getDecision('q-1')).toMatchObject({
      status: 'approved', outcome: 'answered', answer: { answers: { 方向: '品牌与市场团队' } },
    });
    const event = gateway.syncForDevice('phone', 1, 0).events.filter(item => item.kind === 'question').at(-1);
    expect(event?.payload).toMatchObject({ status: 'approved', outcome: 'answered', answer: { answers: { 方向: '品牌与市场团队' } } });
    expect(JSON.stringify(event?.payload)).not.toMatch(/另一端/);
  });

  it('question timeout is expired and abort is cancelled', () => {
    questions.offer(questionRequest, () => {});
    cancelRegisteredUserQuestion('q-1', { outcome: 'expired' });
    expect(gateway.getDecision('q-1')).toMatchObject({ status: 'closed', outcome: 'expired' });
    questions.offer({ ...questionRequest, id: 'q-2' }, () => {});
    cancelRegisteredUserQuestion('q-2', { outcome: 'cancelled' });
    expect(gateway.getDecision('q-2')).toMatchObject({ status: 'closed', outcome: 'cancelled' });
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
    expect((await gateway.submit(command)).kind).toBe('accepted');
    await expect(pending).resolves.toMatchObject({ approved: true, feedback: 'go', autoApproved: false });
    expect(gate.getPendingPlans()).toEqual([]);
    vi.useRealTimers();
  });

  it('a second command ID cannot redispatch a question whose first outcome is unknown', async () => {
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
    expect((await racing.submit(command)).kind).toBe('replayed');
    expect(await racing.submit({ ...command, commandId: 'q-unknown-2' })).toMatchObject({ kind: 'replayed', command: { state: 'reconciling' } });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_decision_claims').get()).toEqual({ n: 1 });
  });

  it('two phones racing the same question: only the first CAS claim settles the decision point', async () => {
    let calls = 0;
    questions.offer(questionRequest, () => { calls += 1; });
    const card = gateway.getDecision('q-1')!;
    const base = {
      version: 1 as const, scopeEpoch: 1, sessionId, action: 'question.respond' as const,
      expectedRevision: card.revision,
      payload: { requestId: 'q-1', operationDigest: card.operationDigest!, answers: { 方向: '继续' } },
    };
    expect((await gateway.submit({ ...base, deviceId: 'phone', commandId: 'first' })).kind).toBe('accepted');
    expect((await gateway.submit({ ...base, deviceId: 'phone-two', commandId: 'second' })).kind).toBe('approval_conflict');
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
    expect((await gateway.submit({ ...base, deviceId: 'phone', commandId: 'plan-first' })).kind).toBe('accepted');
    expect((await gateway.submit({ ...base, deviceId: 'phone-two', commandId: 'plan-second' })).kind).toBe('approval_conflict');
    await expect(pending).resolves.toMatchObject({ approved: true });
    vi.useRealTimers();
  });

  it('revoked device cannot respond to a live question', async () => {
    questions.offer(questionRequest, () => {});
    const card = gateway.getDecision('q-1')!;
    gateway.revokeDevice('phone', 2_000);
    expect((await gateway.submit({
      version: 1, deviceId: 'phone', scopeEpoch: 2, commandId: 'revoked', sessionId,
      action: 'question.respond', expectedRevision: card.revision,
      payload: { requestId: 'q-1', operationDigest: card.operationDigest!, answers: { 方向: '继续' } },
    })).kind).toBe('rejected');
  });

  it('wrong session scope is rejected before the decision point is touched', async () => {
    questions.offer(questionRequest, () => {});
    const card = gateway.getDecision('q-1')!;
    expect(await gateway.submit({
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
    expect(gateway.getDecision(planId)).toMatchObject({ status: 'closed', outcome: 'expired' });
    expect((await gateway.submit({
      version: 1, deviceId: 'phone', scopeEpoch: 1, commandId: 'expired', sessionId,
      action: 'plan.respond', expectedRevision: card.revision,
      payload: { requestId: planId, operationDigest: card.operationDigest!, decision: 'approved' },
    })).kind).toBe('approval_conflict');
    vi.useRealTimers();
  });

  it('a plan orphaned by host restart settles the phone card as cancelled without leaking host copy', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_approvals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        agent_id TEXT,
        agent_name TEXT,
        coordinator_id TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        submitted_at INTEGER NOT NULL,
        resolved_at INTEGER,
        feedback TEXT
      );
    `);
    const repo = new PendingApprovalRepository(db);
    // 上一个进程留下的 pending 行：手机端已发布过这张卡（companion_decisions 仍 pending）。
    const orphanId = 'plan___legacy___1_1000';
    repo.insert({
      id: orphanId, kind: 'plan', agentId: 'agent-1', agentName: 'Coder', coordinatorId: 'coord',
      payload: {
        id: orphanId, agentId: 'agent-1', agentName: 'Coder', coordinatorId: 'coord',
        plan: 'dangerous step', risk: { level: 'high', reasons: ['File deletion command'] },
        submittedAt: 1_000, status: 'pending', scope,
      },
      submittedAt: 1_000,
    });
    gateway.registerDecision({ requestId: orphanId, sessionId, revision: 1, operationDigest: 'digest', status: 'pending', resolvedBy: null, kind: 'plan' });
    // 宿主重启：hydrate 把残留行收成孤儿（feedback=Orphaned by process restart）。
    expect(gate.attachPersistence(repo, 2_000)).toBe(1);
    expect(gate.getPlan(orphanId)).toMatchObject({ status: 'rejected', resolutionOrigin: 'orphaned' });

    plans.refresh();
    expect(gateway.getDecision(orphanId)).toMatchObject({ status: 'closed', outcome: 'cancelled' });
    const event = gateway.syncForDevice('phone', 1, 0).events.filter(item => item.kind === 'plan').at(-1);
    expect(event?.payload).toMatchObject({ status: 'closed', outcome: 'cancelled' });
    // 机器内部串不得当用户可见文案透传，也不得谎称用户提过修改意见。
    expect(JSON.stringify(event?.payload)).not.toMatch(/Orphaned/);
    expect((event?.payload as { answer?: unknown }).answer).toBeUndefined();
  });

  it('a run cancellation settles the phone plan card as cancelled without leaking Cancelled: copy', async () => {
    vi.useFakeTimers();
    const pending = gate.submitForApproval({
      agentId: 'agent-1', agentName: 'Coder', coordinatorId: 'coord',
      plan: 'rewrite launcher', risk: { level: 'medium', reasons: ['Dangerous command: rm'] },
      scope,
    });
    await vi.advanceTimersByTimeAsync(0);
    plans.refresh();
    const planId = gate.getPendingPlans(scope)[0].id;
    gate.cancelRun(scope, 'user stop');
    await expect(pending).resolves.toMatchObject({ approved: false, autoApproved: true });
    plans.refresh();
    expect(gateway.getDecision(planId)).toMatchObject({ status: 'closed', outcome: 'cancelled' });
    const event = gateway.syncForDevice('phone', 1, 0).events.filter(item => item.kind === 'plan').at(-1);
    expect(event?.payload).toMatchObject({ status: 'closed', outcome: 'cancelled' });
    expect(JSON.stringify(event?.payload)).not.toMatch(/Cancelled:/);
    expect((event?.payload as { answer?: unknown }).answer).toBeUndefined();
    vi.useRealTimers();
  });

  it('a desktop rejection with real user feedback still settles as answered revision', async () => {
    vi.useFakeTimers();
    const pending = gate.submitForApproval({
      agentId: 'agent-1', agentName: 'Coder', coordinatorId: 'coord',
      plan: 'batch import', risk: { level: 'medium', reasons: ['Dangerous command: rm'] },
      scope,
    });
    await vi.advanceTimersByTimeAsync(0);
    plans.refresh();
    const planId = gate.getPendingPlans(scope)[0].id;
    gate.reject(planId, '改用批量接口，别一条条来');
    await expect(pending).resolves.toMatchObject({ approved: false, feedback: '改用批量接口，别一条条来', autoApproved: false });
    plans.refresh();
    expect(gateway.getDecision(planId)).toMatchObject({
      status: 'rejected', outcome: 'answered', answer: { decision: 'rejected', feedback: '改用批量接口，别一条条来' },
    });
    const event = gateway.syncForDevice('phone', 1, 0).events.filter(item => item.kind === 'plan').at(-1);
    expect(event?.payload).toMatchObject({ outcome: 'answered', answer: { feedback: '改用批量接口，别一条条来' } });
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

  it('does not offer a question for a session no live phone can access', () => {
    const other: UserQuestionRequest = { ...questionRequest, id: 'q-other', sessionId: 'unshared' };
    expect(questions.canOffer('unshared')).toBe(false);
    expect(questions.canOffer(undefined)).toBe(false);
    expect(questions.offer(other, () => {})).toBe(false);
    expect(gateway.getDecision('q-other')).toBeNull();
    expect(canOfferRegisteredUserQuestion('unshared')).toBe(false);
    expect(canOfferRegisteredUserQuestion(undefined)).toBe(false);
    expect(questions.canOffer(sessionId)).toBe(true);
    expect(questions.offer(questionRequest, () => {})).toBe(true);
    expect(gateway.getDecision('q-1')).toMatchObject({ status: 'pending', kind: 'question' });
    expect(gateway.syncForDevice('phone', 1, 0).events.some(event => event.kind === 'question' && event.sessionId === sessionId)).toBe(true);
  });

  it('does not project a plan for a session no live phone can access', async () => {
    vi.useFakeTimers();
    const otherScope: SwarmRunScope = { sessionId: 'unshared', runId: 'run-other', treeId: 'tree-other' };
    gate.submitForApproval({
      agentId: 'agent-1', agentName: 'Coder', coordinatorId: 'coord',
      plan: 'secret plan for B', risk: { level: 'medium', reasons: ['Dangerous command: rm'] },
      scope: otherScope,
    });
    await vi.advanceTimersByTimeAsync(0);
    plans.refresh();
    const otherId = gate.getPendingPlans(otherScope)[0].id;
    expect(gateway.getDecision(otherId)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM companion_events WHERE kind = 'plan'").get()).toEqual({ n: 0 });
    expect(gate.getPendingPlans(otherScope)).toHaveLength(1);

    gate.submitForApproval({
      agentId: 'agent-2', agentName: 'Coder', coordinatorId: 'coord',
      plan: 'shared plan for A', risk: { level: 'medium', reasons: ['Dangerous command: rm'] },
      scope,
    });
    await vi.advanceTimersByTimeAsync(0);
    plans.refresh();
    const sharedId = gate.getPendingPlans(scope)[0].id;
    expect(gateway.getDecision(sharedId)).toMatchObject({ status: 'pending', kind: 'plan' });
    expect(gateway.syncForDevice('phone', 1, 0).events.some(event => event.kind === 'plan' && event.sessionId === sessionId)).toBe(true);
    vi.useRealTimers();
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
