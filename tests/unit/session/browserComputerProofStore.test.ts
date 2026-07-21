import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutionResult } from '../../../src/host/tools/types';

const mockConfig = vi.hoisted(() => ({
  userConfigDir: '',
}));

vi.mock('../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfig.userConfigDir,
}));

import {
  getBrowserComputerProofLedgerPath,
  persistBrowserComputerProofFromResult,
  readBrowserComputerProofRecordsBySession,
} from '../../../src/host/session/browserComputerProofStore';
import { exportSessionToMarkdown } from '../../../src/host/session/exportMarkdown';

describe('browserComputerProofStore', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'browser-computer-proof-store-'));
    mockConfig.userConfigDir = tempRoot;
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  function makeResult(): ToolExecutionResult {
    return {
      success: true,
      output: 'Screenshot saved at /Users/linchen/Desktop/private.png',
      metadata: {
        traceId: 'trace-1',
        browserComputerProof: {
          evidenceRefs: [{
            id: 'evidence-1',
            kind: 'screenshot',
            ref: '/Users/linchen/Desktop/private.png',
            source: 'screenshot',
            freshness: { capturedAtMs: 1, state: 'fresh' },
          }, {
            id: 'evidence-2',
            kind: 'screenshot',
            ref: 'data:image/png;base64,abcdef',
            source: 'screenshot',
            freshness: { capturedAtMs: 1, state: 'fresh' },
          }],
          visualObservation: {
            observed: false,
            source: 'none',
            reason: 'screenshot_path_only',
            cannotObserveScreen: true,
          },
        },
        browserComputerEvidenceCard: {
          title: 'Browser/Computer Evidence',
          status: 'not_observed',
          summary: 'screenshot_path_only',
          evidenceRefIds: ['evidence-1', 'evidence-2'],
        },
      },
    };
  }

  it('persists sanitized Browser/Computer proof records by session', async () => {
    const record = persistBrowserComputerProofFromResult(makeResult(), {
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      toolName: 'screenshot',
      now: () => 123,
    });

    expect(record).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      toolName: 'screenshot',
      status: 'not_observed',
      summary: 'screenshot_path_only',
      traceId: 'trace-1',
      evidenceRefIds: ['evidence-1', 'evidence-2'],
      targetKind: 'screenshot',
    }));

    const rawLedger = await readFile(getBrowserComputerProofLedgerPath(), 'utf-8');
    expect(rawLedger).not.toContain('/Users/linchen');
    expect(rawLedger).not.toContain('base64,abcdef');
    expect(rawLedger).toContain('.../private.png');

    const records = readBrowserComputerProofRecordsBySession('session-1');
    expect(records).toHaveLength(1);
    expect(records[0].card).toEqual(expect.objectContaining({
      status: 'not_observed',
      summary: 'screenshot_path_only',
    }));
  });

  it('does not write records without a session or proof payload', () => {
    expect(persistBrowserComputerProofFromResult(makeResult(), {
      toolName: 'screenshot',
    })).toBeNull();
    expect(persistBrowserComputerProofFromResult({
      success: true,
      metadata: {},
    }, {
      sessionId: 'session-1',
      toolName: 'screenshot',
    })).toBeNull();
    expect(readBrowserComputerProofRecordsBySession('session-1')).toEqual([]);
  });

  it('persists the additive Surface evidence card without changing the legacy schema', async () => {
    const record = persistBrowserComputerProofFromResult({
      success: false,
      metadata: {
        surfaceEvidenceCardV1: {
          version: 1,
          evidenceId: 'surface-proof-1',
          summary: 'Verification surface-secret-canary-ledger failed.',
          inspection: { verificationState: 'rejected' },
        },
        surfaceProofScopeV1: {
          version: 1,
          conversationId: 'session-surface',
          runId: 'run-1',
          agentId: 'agent-1',
          surfaceSessionId: 'surface-1',
          operationId: 'operation-1',
        },
      },
    }, {
      sessionId: 'session-surface',
      toolCallId: 'operation-1',
      toolName: 'computer_use',
      now: () => 456,
    });

    expect(record).toMatchObject({
      schemaVersion: 1,
      status: 'rejected',
      evidenceRefIds: ['surface-proof-1'],
      targetKind: 'computer',
      surfaceEvidenceCard: { evidenceId: 'surface-proof-1' },
      surfaceScope: { surfaceSessionId: 'surface-1' },
    });
    expect(record?.summary).toBe('Verification [redacted-canary] failed.');
    const rawLedger = await readFile(getBrowserComputerProofLedgerPath(), 'utf-8');
    expect(rawLedger).not.toContain('surface-secret-canary-ledger');
  });

  it('adds proof records to the unified evidence control summary in markdown exports', () => {
    persistBrowserComputerProofFromResult(makeResult(), {
      sessionId: 'session-export',
      toolCallId: 'tool-export',
      toolName: 'screenshot',
      now: () => 123,
    });

    const result = exportSessionToMarkdown({
      sessionId: 'session-export',
      startedAt: 1,
      lastActivityAt: 2,
      totalTokens: 0,
      messages: [{
        id: 'msg-1',
        role: 'assistant',
        content: 'Proof exported',
        timestamp: 1,
      }],
    }, {
      includeMetadata: true,
      includeTimestamps: false,
    });

    expect(result.success).toBe(true);
    expect(result.markdown).toContain('## Evidence Control Summary');
    expect(result.markdown).toContain('browser/computer 1');
    expect(result.markdown).toContain('browser_computer · not_observed · screenshot_path_only');
    expect(result.markdown).toContain('evidence-1');
    expect(result.markdown).not.toContain('/Users/linchen');
    expect(result.markdown).not.toContain('base64,abcdef');
  });
});
