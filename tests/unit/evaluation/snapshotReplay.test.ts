import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Message, ToolDefinition } from '@shared/contract';
import type { ModelMessage } from '@host/agent/loopTypes';
import { buildToolSchemaSnapshot } from '@host/agent/runtime/contextAssembly/inferenceArtifactRepair';
import {
  buildRequestManifest,
  canonicalizeModelMessage,
} from '@host/agent/runtime/contextAssembly/requestManifestBuilder';
import { RequestNotReconstructableError } from '@internal-evaluation/host/evaluation/requestReplay';
import {
  buildSnapshotIdMap,
  buildSnapshotScrubRules,
  buildSnapshotTurnFiles,
  collectSnapshotBlobs,
  normalizeLedgerForSnapshot,
  normalizeManifestForSnapshot,
  replaySnapshotCase,
  scrubSnapshotRecording,
  serializeSnapshotJson,
  SnapshotReplayMismatchError,
  type SnapshotBlobs,
  type SnapshotCaseIndex,
  type SnapshotManifest,
} from '@internal-evaluation/host/evaluation/snapshotReplay';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const READ_TOOL: ToolDefinition = {
  name: 'Read',
  description: 'Read a text fixture.',
  inputSchema: {
    type: 'object',
    properties: { file_path: { type: 'string' } },
    required: ['file_path'],
  },
  outputSchema: { type: 'object' },
  requiresPermission: false,
  permissionLevel: 'read',
};

interface SyntheticCase {
  dir: string;
  index: SnapshotCaseIndex;
  blobs: SnapshotBlobs;
}

/**
 * 用真 builder（buildRequestManifest）+ 内存内容库合成一条单轮快照用例，
 * 走与 --record 完全相同的规范化/擦洗/落盘路径。
 */
function writeSyntheticCase(root: string, options?: { scrub?: boolean }): SyntheticCase {
  const systemPrompt = 'snapshot unit test prompt';
  const tail = options?.scrub
    ? 'snapshot unit test tail, cwd=/tmp/data-x/workspace'
    : 'snapshot unit test tail';
  const ledgerMessages: Message[] = [{
    id: 'u-1',
    role: 'user',
    content: 'E2E_SNAPSHOT_REPLAY_QA ping',
    timestamp: 1726000000000,
  } as Message];
  const actualMessages: ModelMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: ledgerMessages[0].content },
    { role: 'system', content: tail, transient: true },
  ];
  const sourceIds = ['__system_prompt__', 'u-1', '__dynamic_tail__'];
  const toolSnapshot = buildToolSchemaSnapshot([READ_TOOL]);
  const content = new Map<string, string>();
  const systemPrompts = new Map([[sha256(systemPrompt), systemPrompt]]);
  const toolSchemas = new Map([[toolSnapshot.schemaHash, toolSnapshot.schemaJson]]);
  const manifest = buildRequestManifest({
    requestId: 'llm-random-1788786000',
    messages: actualMessages,
    assembledCanonicalMessages: actualMessages.map(canonicalizeModelMessage),
    sourceIds,
    transcriptMessages: ledgerMessages,
    collapsedSpans: [],
    compactionReplacements: [],
    toolSchemaHash: toolSnapshot.schemaHash,
    toolNames: toolSnapshot.toolNames,
    requestConfig: { provider: 'openai', model: 'e2e-local-agent-model' },
    appVersion: 'snapshot-unit-test',
    engine: 'legacy',
    contentStore: { store: (hash, value) => Boolean(content.set(hash, value)) },
    systemPromptStore: { get: (hash) => {
      const value = systemPrompts.get(hash);
      return value == null ? null : { content: value };
    } },
  });
  expect(manifest.degraded).toBe(false);

  const idMap = buildSnapshotIdMap(ledgerMessages);
  const normalizedLedger = normalizeLedgerForSnapshot(ledgerMessages, idMap);
  const normalizedManifests = [
    normalizeManifestForSnapshot(manifest, idMap, 'synthetic-request-01'),
  ];
  const rawBlobs = collectSnapshotBlobs(normalizedManifests, {
    getContent: (hash) => content.get(hash) ?? null,
    getSystemPrompt: (hash) => {
      const value = systemPrompts.get(hash);
      return value == null ? null : { content: value };
    },
    getToolSchema: (hash) => toolSchemas.get(hash) ?? null,
  });

  const baseIndex: SnapshotCaseIndex = {
    version: 1,
    caseId: 'synthetic-qa',
    title: '合成单轮问答',
    coverage: ['single-turn'],
    model: { provider: 'openai', model: 'e2e-local-agent-model' },
    fakeModelEnv: { CODE_AGENT_E2E: '1', CODE_AGENT_E2E_LOCAL_AGENT_MODEL: '1' },
    turns: ['turn-01'],
  };

  let manifests = normalizedManifests;
  let ledger = normalizedLedger;
  let blobs = rawBlobs;
  let index = baseIndex;
  if (options?.scrub) {
    const scrubbed = scrubSnapshotRecording({
      manifests: normalizedManifests,
      ledgerMessages: normalizedLedger,
      blobs: rawBlobs,
      fakeModelEnv: baseIndex.fakeModelEnv,
      rules: buildSnapshotScrubRules({ repoRoot: '/repo/x', dataDir: '/tmp/data-x' }),
    });
    manifests = scrubbed.manifests;
    ledger = scrubbed.ledgerMessages;
    blobs = scrubbed.blobs;
    index = { ...baseIndex, fakeModelEnv: scrubbed.fakeModelEnv };
  }

  const dir = path.join(root, 'synthetic-qa');
  mkdirSync(path.join(dir, 'turn-01'), { recursive: true });
  writeFileSync(path.join(dir, 'index.json'), serializeSnapshotJson(index));
  writeFileSync(path.join(dir, 'ledger.json'), serializeSnapshotJson({ messages: ledger }));
  writeFileSync(path.join(dir, 'blobs.json'), serializeSnapshotJson(blobs));
  const files = buildSnapshotTurnFiles(manifests[0], ledger, blobs, index);
  writeFileSync(path.join(dir, 'turn-01', 'manifest.json'), files.manifestRaw);
  writeFileSync(path.join(dir, 'turn-01', 'canonical-request.json'), files.canonicalRequestRaw);
  writeFileSync(path.join(dir, 'turn-01', 'expected-response.json'), files.expectedResponseRaw);
  return { dir, index, blobs };
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'snapshot-replay-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('snapshotReplay 快照格式往返', () => {
  it('录制路径落盘后可以回放通过（3 种 ref + 假模型响应推导）', () => {
    const root = makeTempDir();
    const { dir } = writeSyntheticCase(root);

    const result = replaySnapshotCase(dir);
    expect(result).toMatchObject({ caseId: 'synthetic-qa', verified: 1, skippedDegraded: 0 });
  });

  it('擦洗家目录/仓路径后哈希自洽、回放仍通过', () => {
    const root = makeTempDir();
    const { dir, blobs } = writeSyntheticCase(root, { scrub: true });

    const allContent = Object.values(blobs.content).join('\n');
    expect(allContent).toContain('<RECORD_DATA_DIR>/workspace');
    for (const bucket of [blobs.content, blobs.systemPrompts, blobs.toolSchemas]) {
      for (const [hash, value] of Object.entries(bucket)) {
        expect(sha256(value)).toBe(hash);
        expect(value).not.toContain('/tmp/data-x');
      }
    }
    expect(replaySnapshotCase(dir).verified).toBe(1);
  });

  it('账本规范化：随机 id 归一、时间戳归零、toolResults metadata 剥除', () => {
    const ledger: Message[] = [
      { id: 'random-uuid-1', role: 'user', content: 'hi', timestamp: 1726000000000 } as Message,
      {
        id: 'random-uuid-2',
        role: 'tool',
        content: '[{"duration":42}]',
        timestamp: 1726000000001,
        toolResults: [{
          toolCallId: 'call-1',
          success: true,
          output: 'ok',
          duration: 42,
          metadata: { createdAt: '2026-09-07T00:00:00Z' },
        }],
      } as unknown as Message,
    ];
    const normalized = normalizeLedgerForSnapshot(ledger, buildSnapshotIdMap(ledger));

    expect(normalized[0]).toEqual({ id: 'msg-01', role: 'user', content: 'hi', timestamp: 0 });
    // 带 toolResults 的 tool 消息 content 归零（投影不读），metadata/duration 剥除
    expect(normalized[1].content).toBe('');
    expect(normalized[1].toolResults).toEqual([{
      toolCallId: 'call-1',
      success: true,
      output: 'ok',
      error: undefined,
    }]);
  });
});

describe('snapshotReplay 变异被拒', () => {
  it('改 canonical-request.json 一个字节必须红', () => {
    const root = makeTempDir();
    const { dir } = writeSyntheticCase(root);
    const file = path.join(dir, 'turn-01', 'canonical-request.json');
    const raw = readFileSync(file, 'utf8');
    writeFileSync(file, raw.replace('snapshot unit test tail', 'snapshot unit test tall'));

    expect(() => replaySnapshotCase(dir)).toThrowError(SnapshotReplayMismatchError);
    try {
      replaySnapshotCase(dir);
    } catch (error) {
      expect(String(error)).toMatch(/turn-01 canonical-request 逐字节不等，第一处差异在 byte \d+/);
    }
  });

  it('改 expected-response.json 必须红', () => {
    const root = makeTempDir();
    const { dir } = writeSyntheticCase(root);
    const file = path.join(dir, 'turn-01', 'expected-response.json');
    const raw = readFileSync(file, 'utf8');
    writeFileSync(file, raw.replace('deterministically', 'deterministica11y'));

    expect(() => replaySnapshotCase(dir)).toThrowError(/turn-01 expected-response 逐字节不等/);
  });

  it('改 blobs.json 内容库一个字节必须红（哈希不符 = 不可重建）', () => {
    const root = makeTempDir();
    const { dir } = writeSyntheticCase(root);
    const file = path.join(dir, 'blobs.json');
    const raw = readFileSync(file, 'utf8');
    writeFileSync(file, raw.replace('snapshot unit test tail', 'snapshot unit test tall'));

    expect(() => replaySnapshotCase(dir)).toThrowError(RequestNotReconstructableError);
  });

  it('改 manifest.json 的账本引用必须红', () => {
    const root = makeTempDir();
    const { dir } = writeSyntheticCase(root);
    const file = path.join(dir, 'turn-01', 'manifest.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as SnapshotManifest;
    const ledgerRef = manifest.messageRefs.find((ref) => ref.kind === 'ledger_message');
    expect(ledgerRef).toBeDefined();
    manifest.messageRefs = manifest.messageRefs.map((ref) => (
      ref.kind === 'ledger_message' ? { ...ref, messageId: 'msg-99' } : ref
    ));
    writeFileSync(file, serializeSnapshotJson(manifest));

    expect(() => replaySnapshotCase(dir)).toThrowError(/账本缺 messageId msg-99/);
  });
});

describe('snapshotReplay degraded 跳过口径', () => {
  it('degraded 轮跳过计数、不算回归失败，与 verifyRequestReplayBatch 同口径', () => {
    const root = makeTempDir();
    const { dir } = writeSyntheticCase(root);
    const file = path.join(dir, 'turn-01', 'manifest.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as SnapshotManifest;
    writeFileSync(file, serializeSnapshotJson({ ...manifest, degraded: true }));

    const result = replaySnapshotCase(dir);
    expect(result).toMatchObject({ verified: 0, skippedDegraded: 1 });
    expect(result.turns[0]).toEqual({ turnId: 'turn-01', status: 'skipped-degraded' });
  });
});
