import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getApplicationRunRegistry,
  resetApplicationRunRegistryForTests,
} from '../../../src/host/app/applicationRunRegistry';
import {
  getSurfaceExecutionRuntime,
  resetSurfaceExecutionRuntimeForTests,
} from '../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import { finalizeSurfaceAwareToolResult } from '../../../src/host/tools/artifacts/surfaceExecutionToolResultPipeline';

afterEach(() => {
  resetSurfaceExecutionRuntimeForTests();
  resetApplicationRunRegistryForTests();
});

describe('surfaceExecutionToolResultPipeline proof projection', () => {
  it('adds the shared evidence card to a compatibility Browser event', async () => {
    const result = await finalizeSurfaceAwareToolResult({
      toolName: 'browser_action',
      arguments: { action: 'screenshot' },
      result: {
        success: true,
        metadata: {
          surfaceSessionId: 'surface-browser-1',
          imagePath: 'artifact://browser-screenshot-1',
          browserComputerProof: {
            evidenceRefs: [{
              id: 'legacy-screenshot-1',
              kind: 'screenshot',
              freshness: { capturedAtMs: 10 },
              redactionStatus: 'clean',
            }],
          },
        },
      },
      workingDirectory: '/tmp',
      conversationId: 'conversation-1',
      runId: 'run-1',
      turnId: 'turn-1',
      agentId: 'agent-1',
      toolCallId: 'tool-1',
      startedAt: 1,
    });

    expect(result.metadata).toMatchObject({
      surfaceProjectionMode: 'compatibility',
      surfaceProofScopeV1: {
        conversationId: 'conversation-1',
        runId: 'run-1',
        turnId: 'turn-1',
        agentId: 'agent-1',
        surfaceSessionId: 'surface-browser-1',
        operationId: 'tool-1',
      },
      surfaceEvidenceCardV1: {
        source: 'browser',
        inspection: {
          captureState: 'captured',
          analysisState: 'not_requested',
          verificationState: 'not_requested',
        },
      },
      surfaceExecutionEventV1: {
        eventId: 'surface-tool:tool-1',
        evidence: [expect.objectContaining({ source: 'browser' })],
      },
    });
  });

  it('projects explicit reverify semantics for failed Computer verification', async () => {
    const result = await finalizeSurfaceAwareToolResult({
      toolName: 'computer_use',
      arguments: { operation: 'act' },
      result: {
        success: false,
        error: 'postcondition not met',
        metadata: {
          surfaceSessionId: 'surface-computer-1',
          surfaceExecutionActionResultV1: {
            predecessorStateId: 'before-1',
            delivery: 'confirmed',
            verification: 'unsatisfied',
            overall: 'failed',
            evidenceRefs: ['after-1'],
          },
        },
      },
      workingDirectory: '/tmp',
      conversationId: 'conversation-1',
      runId: 'run-1',
      agentId: 'agent-1',
      toolCallId: 'tool-2',
      startedAt: 1,
    });

    expect(result.metadata).toMatchObject({
      surfaceProofReverifyV1: {
        required: true,
        operationId: 'tool-2',
        reason: 'rejected',
      },
      surfaceEvidenceCardV1: {
        source: 'computer',
        inspection: {
          verificationState: 'rejected',
          beforeEvidenceRef: expect.stringMatching(/^surface-state:/),
          afterEvidenceRef: expect.any(String),
        },
      },
      surfaceExecutionEventV1: {
        observation: { verdict: 'fail' },
        evidence: [expect.objectContaining({ source: 'computer' })],
      },
    });
  });

  it('redacts a blocked canary result before it can reach logs or durable history', async () => {
    const canary = 'surface-secret-canary-pipeline-persistence';
    const result = await finalizeSurfaceAwareToolResult({
      toolName: 'browser_action',
      arguments: { action: 'click' },
      result: {
        success: false,
        output: `Provider output: ${canary}`,
        error: `Provider error: ${canary}`,
        metadata: {
          surfaceSessionId: 'surface-browser-canary',
          providerDiagnostic: {
            payload: canary,
            thinking: 'raw private chain of thought',
          },
        },
      },
      workingDirectory: '/tmp',
      conversationId: 'conversation-1',
      runId: 'run-1',
      turnId: 'turn-1',
      agentId: 'agent-1',
      toolCallId: 'tool-canary',
      startedAt: 1,
    });

    expect(result.metadata?.surfaceEvidenceCardV1).toMatchObject({
      redactionStatus: 'blocked',
      inspection: { captureState: 'blocked' },
    });
    expect(result.output).toContain('[redacted-canary]');
    expect(result.error).toContain('[redacted-canary]');
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result)).not.toContain('raw private chain of thought');
  });

  it('keeps legacy browser-scoped computer_use evidence on the Browser Surface', async () => {
    const result = await finalizeSurfaceAwareToolResult({
      toolName: 'computer_use',
      arguments: { action: 'smart_click', text: 'Submit' },
      result: { success: true, metadata: { surfaceSessionId: 'surface-browser-legacy' } },
      workingDirectory: '/tmp',
      conversationId: 'conversation-1',
      runId: 'run-1',
      agentId: 'agent-1',
      toolCallId: 'tool-browser-legacy',
      startedAt: 1,
    });

    expect(result.metadata).toMatchObject({
      surfaceEvidenceCardV1: { source: 'browser' },
      surfaceExecutionEventV1: {
        surface: 'browser',
        evidence: [expect.objectContaining({ source: 'browser' })],
      },
    });
  });

  it('creates an unavailable proof card after compatibility projection when no session existed yet', async () => {
    const result = await finalizeSurfaceAwareToolResult({
      toolName: 'browser_action',
      arguments: { action: 'click' },
      result: { success: false, error: 'relay unavailable', metadata: { provider: 'browser-relay' } },
      workingDirectory: '/tmp',
      conversationId: 'conversation-1',
      runId: 'run-1',
      agentId: 'agent-1',
      toolCallId: 'tool-unavailable',
      startedAt: 1,
    });

    expect(result.metadata).toMatchObject({
      surfaceProofScopeV1: { surfaceSessionId: 'legacy-surface:tool-unavailable' },
      surfaceEvidenceCardV1: {
        source: 'browser',
        inspection: {
          captureState: 'unavailable',
          verificationState: 'rejected',
        },
      },
      surfaceExecutionEventV1: {
        evidence: [expect.objectContaining({ source: 'browser' })],
      },
    });
  });

  it('links persisted screenshot proof to an opaque artifact id without retaining inline bytes', async () => {
    const workingDirectory = await mkdtemp(path.join(tmpdir(), 'surface-proof-pipeline-'));
    try {
      const canary = 'SURFACE_REDACTION_CANARY_INLINE_BYTES';
      const result = await finalizeSurfaceAwareToolResult({
        toolName: 'browser_action',
        arguments: { action: 'screenshot' },
        result: {
          success: true,
          metadata: {
            surfaceSessionId: 'surface-browser-artifact',
            imageBase64: Buffer.from(canary.repeat(4)).toString('base64'),
            imageMimeType: 'image/png',
          },
        },
        workingDirectory,
        conversationId: 'conversation-1',
        runId: 'run-1',
        agentId: 'agent-1',
        toolCallId: 'tool-artifact',
        startedAt: 1,
      });

      const artifact = result.metadata?.artifact as { artifactId: string };
      expect(artifact.artifactId).toMatch(/^artifact_/);
      expect(result.metadata?.surfaceEvidenceCardV1).toMatchObject({
        assetRef: artifact.artifactId,
        redactionStatus: 'clean',
      });
      expect(result.metadata?.imageBase64).toBeUndefined();
      expect(JSON.stringify(result.metadata)).not.toContain(canary);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('registers a real production screenshot as an immutable owner-scoped live frame', async () => {
    const workingDirectory = await mkdtemp(path.join(tmpdir(), 'surface-live-frame-pipeline-'));
    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const imagePath = path.join(workingDirectory, 'successor.png');
      await import('node:fs/promises').then((fs) => fs.writeFile(imagePath, png));
      const registry = getApplicationRunRegistry();
      registry.start({
        runId: 'run-live-frame',
        sessionId: 'conversation-live-frame',
        workspace: workingDirectory,
      });
      const runtime = getSurfaceExecutionRuntime();
      const identity = {
        conversationId: 'conversation-live-frame',
        runId: 'run-live-frame',
        agentId: 'agent-live-frame',
      };
      const prepared = runtime.prepareBrowserSession({ identity });

      const result = await finalizeSurfaceAwareToolResult({
        toolName: 'browser_action',
        arguments: { action: 'screenshot' },
        result: {
          success: true,
          metadata: {
            surfaceSessionId: prepared.session.sessionId,
            path: imagePath,
            analyzed: true,
          },
        },
        workingDirectory,
        ...identity,
        toolCallId: 'tool-live-frame',
        startedAt: 1,
      });

      const card = result.metadata?.surfaceEvidenceCardV1 as { assetRef: string; evidenceId: string };
      expect(card.assetRef).toMatch(/^surface-frame:\/\//);
      expect(result.metadata?.surfaceExecutionEventV1).toMatchObject({
        evidence: [expect.objectContaining({
          evidenceId: card.evidenceId,
          assetRef: card.assetRef,
        })],
      });
      await expect(runtime.frames.resolve({
        version: 1,
        conversationId: identity.conversationId,
        surfaceSessionId: prepared.session.sessionId,
        assetRef: card.assetRef,
      })).resolves.toMatchObject({
        mimeType: 'image/png',
        bytes: png.length,
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      });
      expect(runtime.snapshotConversation(identity.conversationId).sessions[0].outputs)
        .toEqual([expect.objectContaining({
          ref: expect.stringMatching(/^surface-output:\/\//),
          label: 'successor.png',
        })]);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('registers only workspace-confined outputPath values and returns redacted text', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'surface-output-pipeline-'));
    const workingDirectory = path.join(root, 'workspace');
    const outsideDirectory = path.join(root, 'outside');
    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(workingDirectory);
      await fs.mkdir(outsideDirectory);
      await fs.symlink(outsideDirectory, path.join(workingDirectory, 'linked-outside'), 'dir');
    });
    try {
      const allowedPath = path.join(workingDirectory, 'verified-output.html');
      const blockedPath = path.join(root, 'provider-forged.txt');
      const linkedBlockedPath = path.join(workingDirectory, 'linked-outside', 'provider-forged-linked.txt');
      await import('node:fs/promises').then(async (fs) => {
        await fs.writeFile(allowedPath, '<title>verified</title> token=surface-secret-canary-output-pipeline');
        await fs.writeFile(blockedPath, 'foreign provider file');
        await fs.writeFile(path.join(outsideDirectory, 'provider-forged-linked.txt'), 'linked foreign provider file');
      });
      const registry = getApplicationRunRegistry();
      registry.start({ runId: 'run-output', sessionId: 'conversation-output', workspace: workingDirectory });
      const runtime = getSurfaceExecutionRuntime();
      const identity = { conversationId: 'conversation-output', runId: 'run-output', agentId: 'agent-output' };
      const prepared = runtime.prepareBrowserSession({ identity });

      await finalizeSurfaceAwareToolResult({
        toolName: 'browser_action',
        arguments: { action: 'click' },
        result: { success: true, metadata: { surfaceSessionId: prepared.session.sessionId, outputPath: blockedPath } },
        workingDirectory,
        ...identity,
        toolCallId: 'tool-output-blocked',
        startedAt: 1,
      });
      expect(runtime.snapshotConversation(identity.conversationId).sessions[0].outputs).toEqual([]);

      await finalizeSurfaceAwareToolResult({
        toolName: 'browser_action',
        arguments: { action: 'click' },
        result: {
          success: true,
          metadata: {
            surfaceSessionId: prepared.session.sessionId,
            artifact: {
              artifactId: 'artifact-forged',
              path: blockedPath,
              sourceTool: 'browser_action',
              sha256: '0'.repeat(64),
            },
          },
        },
        workingDirectory,
        ...identity,
        toolCallId: 'tool-output-forged-schema',
        startedAt: 1,
      });
      expect(runtime.snapshotConversation(identity.conversationId).sessions[0].outputs).toEqual([]);

      await finalizeSurfaceAwareToolResult({
        toolName: 'browser_action',
        arguments: { action: 'click' },
        result: { success: true, metadata: { surfaceSessionId: prepared.session.sessionId, outputPath: linkedBlockedPath } },
        workingDirectory,
        ...identity,
        toolCallId: 'tool-output-linked-blocked',
        startedAt: 1,
      });
      expect(runtime.snapshotConversation(identity.conversationId).sessions[0].outputs).toEqual([]);

      const allowedResult = await finalizeSurfaceAwareToolResult({
        toolName: 'browser_action',
        arguments: { action: 'click' },
        result: { success: true, metadata: { surfaceSessionId: prepared.session.sessionId, outputPath: allowedPath } },
        workingDirectory,
        ...identity,
        toolCallId: 'tool-output-allowed',
        startedAt: 2,
      });
      const output = runtime.snapshotConversation(identity.conversationId).sessions[0].outputs[0];
      expect(output).toMatchObject({ ref: expect.stringMatching(/^surface-output:\/\//), label: 'verified-output.html' });
      const payload = await runtime.outputs.resolve({
        version: 1,
        conversationId: identity.conversationId,
        surfaceSessionId: prepared.session.sessionId,
        outputRef: output.ref,
      });
      expect(payload.contentKind).toBe('text');
      expect(JSON.stringify(payload)).toContain('<title>verified</title>');
      expect(JSON.stringify(payload)).not.toContain('surface-secret-canary-output-pipeline');
      expect(JSON.stringify(allowedResult.metadata?.surfaceExecutionEventsV1)).not.toContain(allowedPath);
      expect(JSON.stringify(runtime.snapshotConversation(identity.conversationId))).not.toContain(blockedPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
