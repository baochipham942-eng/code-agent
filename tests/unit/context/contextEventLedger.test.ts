import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { ContextEventLedger } from '../../../src/main/context/contextEventLedger';
import { CompressionState } from '../../../src/main/context/compressionState';

describe('ContextEventLedger', () => {
  let tempDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'code-agent-context-ledger-'));
    ledgerPath = path.join(tempDir, 'ledger.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists and reloads annotation and compression events', () => {
    const ledger = new ContextEventLedger(ledgerPath);
    const compressionState = new CompressionState();
    const timestamp = Date.now();
    compressionState.applyCommit({
      layer: 'tool-result-budget',
      operation: 'truncate',
      targetMessageIds: ['tool-entry-1'],
      timestamp,
      metadata: { originalTokens: 500, truncatedTokens: 100 },
    });

    ledger.upsertAnnotationEvents('session-1', 'agent-1', {
      msg1: {
        category: 'dependency_carry_over',
        sourceDetail: 'parent context',
        agentId: 'agent-1',
        sourceKind: 'dependency_carry_over',
      },
    });
    ledger.upsertCompressionEvents(
      'session-1',
      'agent-1',
      compressionState.getCommitLog(),
      (messageId) => messageId === 'tool-entry-1' ? 'tool-message-1' : messageId,
    );

    const reloaded = new ContextEventLedger(ledgerPath);
    const events = reloaded.list('session-1', 'agent-1');

    expect(events.map((event) => event.messageId)).toEqual(
      expect.arrayContaining(['msg1', 'tool-message-1']),
    );
    expect(events.find((event) => event.messageId === 'msg1')?.category).toBe('dependency_carry_over');
    expect(events.find((event) => event.messageId === 'tool-message-1')?.layer).toBe('tool-result-budget');
  });

  it('clearSession removes all events for the target session', () => {
    const ledger = new ContextEventLedger(ledgerPath);
    ledger.upsertEvents([
      {
        id: '',
        sessionId: 'session-clear',
        messageId: 'm1',
        category: 'recent_turn',
        action: 'added',
        sourceKind: 'message',
        sourceDetail: 'user_message',
        timestamp: Date.now(),
      },
      {
        id: '',
        sessionId: 'session-keep',
        messageId: 'm2',
        category: 'recent_turn',
        action: 'added',
        sourceKind: 'message',
        sourceDetail: 'assistant_message',
        timestamp: Date.now(),
      },
    ]);

    ledger.clearSession('session-clear');

    expect(ledger.list('session-clear')).toHaveLength(0);
    expect(ledger.list('session-keep')).toHaveLength(1);
  });
});
