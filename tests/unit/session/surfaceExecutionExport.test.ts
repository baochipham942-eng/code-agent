import { describe, expect, it } from 'vitest';
import { exportSessionToMarkdown } from '../../../src/host/session/exportMarkdown';
import { TranscriptExporter } from '../../../src/host/session/transcriptExporter';
import { SessionLocalCache } from '../../../src/host/session/localCache';
import type { CachedSession } from '../../../src/host/session/localCache';
import { sanitizeSurfaceExecutionSessionExport } from '../../../src/host/session/surfaceExecutionSessionExport';
import type { SessionWithMessages } from '../../../src/host/services/infra/sessionManager';

function metadata() {
  return {
    surfaceExecutionSessionV1: {
      version: 1,
      sessionId: 'surface-session-export',
      runId: 'run-export',
      conversationId: 'conversation-export',
      agentId: 'agent-export',
      surface: 'browser',
      provider: 'relay',
      state: 'waiting_human',
      grantId: 'grant-plaintext',
      startedAt: 100,
      heartbeatAt: 150,
    },
    surfaceExecutionEventsV1: [{
      version: 1,
      eventId: 'event-export',
      sequence: 1,
      sessionId: 'surface-session-export',
      runId: 'run-export',
      agentId: 'agent-export',
      surface: 'browser',
      provider: 'relay',
      sessionState: 'waiting_human',
      phase: 'human',
      status: 'waiting',
      userSummary: '登录需要用户接管',
      operation: {
        action: 'click',
        risk: 'write',
      },
      observation: {
        verdict: 'inconclusive',
        findings: ['登录页要求 MFA'],
      },
      evidenceRefs: ['evidence-login'],
      evidence: [{
        version: 1,
        evidenceId: 'evidence-login',
        kind: 'screenshot',
        source: 'browser',
        title: '登录页截图',
        capturedAt: 140,
        captureContext: {
          target: {
            kind: 'browser',
            browserInstanceId: 'browser-export',
            windowRef: 'window-export',
            tabRef: 'tab-export',
            documentRevision: 'revision-export',
            title: 'Sign in',
          },
          sourceUrl: 'https://user:password@example.test/sign-in?token=surface-secret-canary-export-url',
          viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
        },
        redactionStatus: 'redacted',
        inspection: {
          captureState: 'captured',
          analysisState: 'analyzed',
          verificationState: 'inconclusive',
          inspectedAt: 145,
          inspectedBy: { kind: 'agent', id: 'vision', method: 'vision' },
          supportsStepIds: ['step-login'],
          checklist: [{
            id: 'mfa',
            label: '无需 MFA',
            status: 'failed',
            finding: 'MFA required',
          }],
        },
      }],
      artifactRefs: ['artifact:login-screenshot'],
      availableControls: ['takeover', 'stop', 'end_session'],
      startedAt: 120,
      completedAt: 150,
    }],
    surfaceExecutionActionResultV1: {
      version: 1,
      operationId: 'operation-export',
      predecessorStateId: 'state-export',
      delivery: 'confirmed',
      verification: 'inconclusive',
      overall: 'ambiguous',
      evidenceRefs: ['evidence-login'],
      artifactRefs: ['artifact:login-screenshot'],
    },
    selector: '#mfa-secret',
    token: 'surface-secret-canary-export',
  };
}

function cachedSession(): CachedSession {
  const surfaceMetadata = metadata();
  return {
    sessionId: 'conversation-export',
    startedAt: 100,
    lastActivityAt: 150,
    totalTokens: 0,
    messages: [{
      id: 'assistant-export',
      role: 'assistant' as const,
      content: '请完成登录接管。',
      timestamp: 150,
      metadata: surfaceMetadata,
      toolCalls: [{
        id: 'tool-export',
        name: 'browser_action',
        arguments: {
          action: 'click',
          selector: '#mfa-secret',
          text: 'surface-secret-canary-input',
        },
      }],
      toolResults: [{
        toolCallId: 'tool-export',
        success: false,
        error: 'surface-secret-canary-result',
        metadata: surfaceMetadata,
      }],
    }],
  };
}

function ledgerOnlyCachedSession(): CachedSession {
  const eventBase = {
    version: 1 as const,
    sessionId: 'surface-ledger-export',
    conversationId: 'conversation-ledger-export',
    runId: 'run-ledger-export',
    agentId: 'agent-ledger-export',
    surface: 'browser' as const,
    provider: 'relay',
    evidenceRefs: [] as string[],
    artifactRefs: [] as string[],
    startedAt: 200,
  };
  return {
    sessionId: 'conversation-ledger-export',
    startedAt: 100,
    lastActivityAt: 300,
    totalTokens: 0,
    metadata: {
      surfaceExecutionLedgerV1: {
        version: 1,
        conversationId: 'conversation-ledger-export',
        updatedAt: 300,
        sessions: [{
          version: 1,
          session: {
            version: 1,
            sessionId: 'surface-ledger-export',
            runId: 'run-ledger-export',
            conversationId: 'conversation-ledger-export',
            agentId: 'agent-ledger-export',
            surface: 'browser',
            provider: 'relay',
            capabilities: {
              version: 1,
              surface: 'browser',
              provider: 'relay',
              protocolVersion: 'surface-execution-v1',
              operations: ['raw-ledger-action-secret'],
              observationKinds: ['screenshot'],
              supports: {
                cancel: true,
                pause: true,
                takeover: true,
                cleanup: true,
                successorObservation: true,
              },
            },
            state: 'completed',
            startedAt: 100,
            heartbeatAt: 300,
          },
          grant: {
            state: 'revoked',
            capabilities: ['observe'],
            actionClasses: ['private-action-class'],
            dataScopes: ['cookie:surface-secret-canary-ledger-export'],
            grantId: 'grant-ledger-export-secret',
          },
          events: [{
            ...eventBase,
            eventId: 'ledger-takeover',
            sequence: 1,
            sessionState: 'waiting_human',
            phase: 'human',
            status: 'succeeded',
            userSummary: '用户已接管',
            operation: { action: 'takeover', risk: 'control' },
            availableControls: ['stop'],
            completedAt: 210,
          }, {
            ...eventBase,
            eventId: 'ledger-stop',
            sequence: 2,
            sessionState: 'stopping',
            phase: 'human',
            status: 'succeeded',
            userSummary: '执行已停止',
            operation: { action: 'stop', risk: 'control' },
            availableControls: ['end_session'],
            startedAt: 220,
            completedAt: 230,
          }, {
            ...eventBase,
            eventId: 'ledger-cleanup',
            sequence: 3,
            sessionState: 'completed',
            phase: 'cleanup',
            status: 'succeeded',
            userSummary: '标签页已归还',
            observation: { verdict: 'pass', findings: ['控制权已归还'] },
            availableControls: [],
            startedAt: 240,
            completedAt: 300,
          }],
          evidence: [],
          outputs: [],
          availableControls: [],
          source: 'persisted',
          writable: false,
          updatedAt: 300,
        }],
      },
    },
    messages: [{
      id: 'assistant-ledger-export',
      role: 'assistant',
      content: '执行已由用户停止并完成清理。',
      timestamp: 300,
    }],
  };
}

describe('Surface Execution session exports', () => {
  it('adds a persistent semantic timeline to Host Markdown without authority or selector payloads', () => {
    const result = exportSessionToMarkdown(cachedSession(), {
      includeMetadata: false,
      includeToolDetails: true,
      guardSensitiveData: false,
    });

    expect(result.success).toBe(true);
    expect(result.markdown).toContain('## Surface Execution');
    expect(result.markdown).toContain('human · waiting · 登录需要用户接管');
    expect(result.markdown).toContain('capture=captured');
    expect(result.markdown).toContain('analysis=analyzed');
    expect(result.markdown).toContain('verification=inconclusive');
    expect(result.markdown).toContain('Controls: takeover, stop, end_session');
    expect(result.markdown).toContain('Outputs: artifact:login-screenshot');
    expect(result.markdown).not.toContain('#mfa-secret');
    expect(result.markdown).not.toContain('grant-plaintext');
    expect(result.markdown).not.toContain('surface-secret-canary');
    expect(result.markdown).not.toContain('surfaceExecutionSessionV1');
  });

  it('adds the same safe projection to Transcript JSON while preserving ordinary metadata', async () => {
    const session = cachedSession();
    session.messages[0].metadata = {
      ...session.messages[0].metadata,
      ordinaryMetadata: 'preserved',
    };
    const cache = new SessionLocalCache({ maxSessions: 5 });
    cache.setSession(session);
    const exporter = new TranscriptExporter({ cache });
    const result = await exporter.exportTranscript(session.sessionId, {
      format: 'json',
      guardSensitiveData: false,
    });
    const parsed = JSON.parse(result.markdown || '{}') as {
      surfaceExecution: { sessions: Array<{ events: Array<Record<string, unknown>> }> };
      messages: Array<{ metadata: Record<string, unknown> }>;
    };
    const serialized = JSON.stringify(parsed);

    expect(result.success).toBe(true);
    expect(parsed.surfaceExecution.sessions[0].events[0]).toMatchObject({
      phase: 'human',
      status: 'waiting',
      evidence: [{
        captureContext: {
          target: {
            kind: 'browser',
            browserInstanceId: 'browser-export',
            windowRef: 'window-export',
            tabRef: 'tab-export',
            documentRevision: 'revision-export',
            title: 'Sign in',
          },
          sourceUrl: 'https://example.test/sign-in',
          viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
        },
        captureState: 'captured',
        analysisState: 'analyzed',
        verificationState: 'inconclusive',
      }],
    });
    expect(parsed.messages[0].metadata.ordinaryMetadata).toBe('preserved');
    expect(parsed.messages[0].metadata.surfaceExecutionExportV1).toBeDefined();
    expect(serialized).not.toContain('surfaceExecutionSessionV1');
    expect(serialized).not.toContain('grant-plaintext');
    expect(serialized).not.toContain('#mfa-secret');
    expect(serialized).not.toContain('surface-secret-canary');
    expect(serialized).not.toContain('user:password');
    expect(serialized).not.toContain('?token=');
  });

  it('keeps JSON session export import-shaped but removes raw reasoning and Surface authority', () => {
    const surfaceMetadata = metadata();
    const session = {
      id: 'conversation-export',
      title: 'Surface export',
      modelConfig: { provider: 'openai', model: 'test' },
      createdAt: 100,
      updatedAt: 150,
      messages: [{
        id: 'assistant-export',
        role: 'assistant',
        content: '用户可见结果',
        timestamp: 150,
        reasoning: 'raw private chain of thought',
        thinking: 'raw hidden reasoning',
        toolCalls: [{
          id: 'tool-export',
          name: 'browser_action',
          arguments: { action: 'click', selector: '#mfa-secret' },
        }],
        toolResults: [{
          toolCallId: 'tool-export',
          success: false,
          error: 'surface-secret-canary-result',
          metadata: surfaceMetadata,
        }],
      }],
      todos: [],
      messageCount: 1,
    } as unknown as SessionWithMessages;

    const exported = sanitizeSurfaceExecutionSessionExport(session);
    const serialized = JSON.stringify(exported);

    expect(exported.id).toBe(session.id);
    expect(exported.messages[0].content).toBe('用户可见结果');
    expect(exported.messages[0].reasoning).toBeUndefined();
    expect(exported.messages[0].thinking).toBeUndefined();
    expect(exported.messages[0].toolCalls?.[0].arguments).toEqual({ action: 'click' });
    expect(exported.metadata?.surfaceExecutionExportV1).toBeDefined();
    expect(serialized).not.toContain('raw private chain of thought');
    expect(serialized).not.toContain('raw hidden reasoning');
    expect(serialized).not.toContain('#mfa-secret');
    expect(serialized).not.toContain('grant-plaintext');
    expect(serialized).not.toContain('surface-secret-canary');
  });

  it('keeps legacy Browser arguments import-shaped while applying the existing redaction rules', () => {
    const session = {
      id: 'conversation-legacy-export',
      title: 'Legacy Browser export',
      modelConfig: { provider: 'openai', model: 'test' },
      createdAt: 100,
      updatedAt: 150,
      messages: [{
        id: 'assistant-legacy-export',
        role: 'assistant',
        content: 'Legacy result',
        timestamp: 150,
        toolCalls: [{
          id: 'tool-legacy-export',
          name: 'browser_action',
          arguments: { action: 'type', selector: '#email', text: 'secret@example.com' },
        }],
      }],
      todos: [],
      messageCount: 1,
    } as unknown as SessionWithMessages;

    const exported = sanitizeSurfaceExecutionSessionExport(session);
    const args = exported.messages[0].toolCalls?.[0].arguments;

    expect(args).toMatchObject({ action: 'type', selector: '#email' });
    expect(JSON.stringify(args)).not.toContain('secret@example.com');
    expect(exported.metadata?.surfaceExecutionExportV1).toBeUndefined();
  });

  it('keeps non-Surface legacy metadata import-shaped across export and import sanitization', () => {
    const legacyMetadata = {
      path: 'relative/legacy-cache.json',
      target: { kind: 'legacy-selection', value: 'Summary!A1' },
      approval: { status: 'preexisting' },
      grant: { source: 'legacy-plugin' },
      customField: 'kept',
      reasoning: 'private legacy reasoning',
      token: 'private-legacy-token',
    };
    const session = {
      id: 'conversation-non-surface-legacy-export',
      title: 'Non-Surface legacy export',
      modelConfig: { provider: 'openai', model: 'test' },
      createdAt: 100,
      updatedAt: 150,
      metadata: legacyMetadata,
      messages: [{
        id: 'assistant-non-surface-legacy-export',
        role: 'assistant',
        content: 'Legacy result',
        timestamp: 150,
        metadata: legacyMetadata,
        toolCalls: [{
          id: 'tool-non-surface-legacy-export',
          name: 'Read',
          arguments: { file_path: 'README.md' },
          result: {
            toolCallId: 'tool-non-surface-legacy-export',
            success: true,
            metadata: legacyMetadata,
          },
        }],
        toolResults: [{
          toolCallId: 'tool-non-surface-legacy-export',
          success: true,
          metadata: legacyMetadata,
        }],
      }],
      todos: [],
      messageCount: 1,
    } as unknown as SessionWithMessages;

    const exported = sanitizeSurfaceExecutionSessionExport(session);
    const imported = sanitizeSurfaceExecutionSessionExport(exported);
    const expected = {
      path: 'relative/legacy-cache.json',
      target: { kind: 'legacy-selection', value: 'Summary!A1' },
      approval: { status: 'preexisting' },
      grant: { source: 'legacy-plugin' },
      customField: 'kept',
      token: '[redacted]',
    };

    expect(imported.metadata).toMatchObject(expected);
    expect(imported.messages[0].metadata).toMatchObject(expected);
    expect(imported.messages[0].toolCalls?.[0].result?.metadata).toMatchObject(expected);
    expect(imported.messages[0].toolResults?.[0].metadata).toMatchObject(expected);
    expect(JSON.stringify(imported)).not.toContain('private legacy reasoning');
    expect(imported.metadata?.surfaceExecutionExportV1).toBeUndefined();
  });

  it('exports durable ledger control and cleanup events even when no ToolResult follows', async () => {
    const cached = ledgerOnlyCachedSession();
    const markdown = exportSessionToMarkdown(cached, {
      includeMetadata: false,
      guardSensitiveData: false,
    });
    const cache = new SessionLocalCache({ maxSessions: 5 });
    cache.setSession(cached);
    const transcript = await new TranscriptExporter({ cache }).exportTranscript(cached.sessionId, {
      format: 'json',
      guardSensitiveData: false,
    });
    const parsed = JSON.parse(transcript.markdown || '{}') as {
      surfaceExecution: { sessions: Array<{ events: Array<Record<string, unknown>> }> };
    };
    const exported = sanitizeSurfaceExecutionSessionExport({
      id: cached.sessionId,
      title: 'Ledger export',
      modelConfig: { provider: 'openai', model: 'test' },
      createdAt: cached.startedAt,
      updatedAt: cached.lastActivityAt,
      metadata: cached.metadata,
      messages: cached.messages,
      todos: [],
      messageCount: cached.messages.length,
    } as unknown as SessionWithMessages);
    const serialized = JSON.stringify({ markdown, transcript: parsed, exported });

    expect(markdown.markdown).toContain('用户已接管');
    expect(markdown.markdown).toContain('执行已停止');
    expect(markdown.markdown).toContain('cleanup · succeeded · 标签页已归还');
    expect(parsed.surfaceExecution.sessions[0].events).toHaveLength(3);
    expect(exported.metadata?.surfaceExecutionExportV1).toBeDefined();
    expect(exported.metadata?.surfaceExecutionLedgerV1).toBeUndefined();
    expect(serialized).not.toContain('grant-ledger-export-secret');
    expect(serialized).not.toContain('surface-secret-canary-ledger-export');
    expect(serialized).not.toContain('raw-ledger-action-secret');
  });
});
