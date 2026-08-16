import { createHash } from 'crypto';
import type { Message, ToolDefinition } from '../../src/shared/contract';
import type { ModelMessage } from '../../src/host/agent/loopTypes';
import { buildToolSchemaSnapshot } from '../../src/host/agent/runtime/contextAssembly/inferenceArtifactRepair';
import {
  buildRequestManifest,
  canonicalizeModelMessage,
} from '../../src/host/agent/runtime/contextAssembly/requestManifestBuilder';
import {
  assertReconstructedRequestMatches,
  RequestReplayMismatchError,
  verifyRequestReplay,
  verifyRequestReplayBatch,
} from '../../src/host/evaluation/requestReplayGate';
import { RequestNotReconstructableError } from '../../src/host/evaluation/requestReplay';
import { ModelRouter } from '../../src/host/model/modelRouter';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function main(): Promise<void> {
  process.env.CODE_AGENT_E2E = '1';
  process.env.CODE_AGENT_E2E_LOCAL_AGENT_MODEL = '1';

  const systemPrompt = 'N-REPLAY keyless first-request smoke';
  const ledgerMessages: Message[] = [{
    id: 'replay-smoke-user',
    role: 'user',
    content: 'Read the deterministic E2E fixture.',
    timestamp: 1,
  }];
  const actualMessages: ModelMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: ledgerMessages[0].content },
    { role: 'system', content: 'runtime replay smoke tail', transient: true },
  ];
  const sourceIds = ['__system_prompt__', ledgerMessages[0].id, '__dynamic_tail__'];
  const tools: ToolDefinition[] = [{
    name: 'Read',
    description: 'Read a text fixture.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['file_path'],
    },
    outputSchema: { type: 'object' },
    requiresPermission: false,
    permissionLevel: 'read',
  }];
  const toolSnapshot = buildToolSchemaSnapshot(tools);
  const content = new Map<string, string>();
  const systemPrompts = new Map([[sha256(systemPrompt), systemPrompt]]);
  const toolSchemas = new Map([[toolSnapshot.schemaHash, toolSnapshot.schemaJson]]);
  const manifest = buildRequestManifest({
    requestId: 'replay-smoke-request',
    messages: actualMessages,
    assembledCanonicalMessages: actualMessages.map(canonicalizeModelMessage),
    sourceIds,
    transcriptMessages: ledgerMessages,
    collapsedSpans: [],
    toolSchemaHash: toolSnapshot.schemaHash,
    toolNames: toolSnapshot.toolNames,
    requestConfig: { provider: 'openai', model: 'e2e-local-agent-model' },
    appVersion: 'request-replay-smoke',
    engine: 'legacy',
    contentStore: {
      store(hash, value) {
        content.set(hash, value);
        return true;
      },
    },
    systemPromptStore: {
      get: (hash) => {
        const value = systemPrompts.get(hash);
        return value == null ? null : { content: value };
      },
    },
  });
  const readers = {
    getSystemPrompt: (hash: string) => {
      const value = systemPrompts.get(hash);
      return value == null ? null : { content: value };
    },
    getContent: (hash: string) => content.get(hash) ?? null,
    getToolSchema: (hash: string) => toolSchemas.get(hash) ?? null,
  };

  // Capture the exact arrays crossing the engine boundary. This smoke covers
  // only the first assembled request: compact/non-streaming/network retries can
  // reuse the first manifest while sending rewritten messages.
  const router = new ModelRouter();
  const response = await router.inference(
    actualMessages,
    tools,
    { provider: 'openai', model: 'e2e-local-agent-model' },
  );
  if (response.type !== 'tool_use' || response.toolCalls?.[0]?.name !== 'Read') {
    throw new Error(`E2E local model did not issue the expected Read tool call: ${JSON.stringify(response)}`);
  }

  const replayCase = {
    manifest,
    ledgerMessages,
    readers,
    actualMessages,
    actualTools: tools,
  };
  const degradedManifest = { ...manifest, requestId: 'replay-smoke-degraded', degraded: true };
  const batch = verifyRequestReplayBatch([replayCase, { ...replayCase, manifest: degradedManifest }]);
  if (batch.verified !== 1 || batch.skippedDegraded !== 1) {
    throw new Error(`unexpected replay batch result: ${JSON.stringify(batch)}`);
  }

  const dynamicRef = manifest.messageRefs.find((ref) => ref.kind === 'content');
  if (!dynamicRef || dynamicRef.kind !== 'content') throw new Error('smoke manifest missing content ref');
  const original = content.get(dynamicRef.contentHash);
  if (!original) throw new Error('smoke content cache missing dynamic tail');
  content.set(dynamicRef.contentHash, original.replace('tail', 'tall'));
  let mutationWasRejected = false;
  try {
    verifyRequestReplay(replayCase);
  } catch (error) {
    // 内容库被篡改 = 哈希对不上 = 不可重建；其它错误形态（崩溃 bug）不许冒充变异被拒
    mutationWasRejected = error instanceof RequestNotReconstructableError;
  }
  if (!mutationWasRejected) throw new Error('content mutation did not raise RequestNotReconstructableError');

  // 反向变异之二：实发侧被篡改（重建正常、对比必须逐字节咬住）
  content.set(dynamicRef.contentHash, original);
  const reconstructed = verifyRequestReplay(replayCase);
  const tamperedActual = actualMessages.map((message, index) =>
    index === 2 ? { ...message, content: 'runtime replay smoke tall' } : message);
  let mismatchWasRejected = false;
  try {
    assertReconstructedRequestMatches(tamperedActual, toolSnapshot.schemaJson, reconstructed);
  } catch (error) {
    mismatchWasRejected = error instanceof RequestReplayMismatchError;
  }
  if (!mismatchWasRejected) throw new Error('actual-side mutation did not raise RequestReplayMismatchError');

  console.log('request replay smoke passed: 1 keyless tool-call request, 3 ref kinds, both mutation controls rejected');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
