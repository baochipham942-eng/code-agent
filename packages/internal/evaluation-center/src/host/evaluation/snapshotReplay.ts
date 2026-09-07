// ============================================================================
// snapshotReplay — request-replay 快照语料的序列化、规范化与回放比对
// ============================================================================
//
// N-SNAPSHOT-REGRESSION（DSH P1-M2）：把 request-replay 从单条手写 fixture 的
// smoke 升级成「录一批 keyless 确定性假模型真会话的快照回归」。本模块是
// 录制器（scripts/acceptance/snapshot-replay.ts --record）与回放器（默认模式、
// 单测）共享的唯一序列化/比对真源：
//
// - 快照目录每用例一组文件：index.json / ledger.json / blobs.json /
//   turn-NN/{manifest,canonical-request,expected-response}.json
// - 回放 = 用当前代码 reconstructRequest 重建快照 manifest，逐字节比对
//   canonical-request.json；再用当前假模型对重建出的请求重推导响应，逐字节
//   比对 expected-response.json。degraded 轮沿用 verifyRequestReplayBatch 的
//   跳过口径，不算回归失败。
// - 生成器确定性：id 全部规范化成 msg-NN/request-NN，时间戳归零，blobs 按键
//   排序，序列化统一走 serializeSnapshotJson。会话 id / 请求 id / 时间戳不进
//   快照正文。
// ============================================================================

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';

import type { Message, ModelConfig, ToolDefinition } from '@shared/contract';
import type { ModelResponse } from '@host/model/types';
import type { TraceEventDataMap } from '@host/agent/runtime/turnTrace';
import { buildE2ELocalAgentModelResponse } from '@host/testing/e2e/e2eLocalAgentModel';

import {
  reconstructRequest,
  type RequestReplayContentReaders,
  type ReconstructedRequest,
} from './requestReplay';

export type SnapshotManifest = TraceEventDataMap['request_manifest'];

export interface SnapshotCaseIndex {
  version: 1;
  caseId: string;
  title: string;
  /** 该用例覆盖的工具路径（人读 + 同步门报错提示用）。 */
  coverage: string[];
  model: { provider: string; model: string };
  /**
   * 假模型按 env 解析 Read 夹具 / Write 目标路径（resolveFixturePath /
   * resolveSnapshotWritePath）。回放重推导响应时必须与录制时一致，否则
   * 工具调用参数里的路径字节对不上。
   */
  fakeModelEnv: Record<string, string>;
  turns: string[];
}

export interface SnapshotBlobs {
  content: Record<string, string>;
  systemPrompts: Record<string, string>;
  toolSchemas: Record<string, string>;
}

interface SnapshotTurnReplayResult {
  turnId: string;
  status: 'verified' | 'skipped-degraded';
}

export interface SnapshotCaseReplayResult {
  caseId: string;
  verified: number;
  skippedDegraded: number;
  turns: SnapshotTurnReplayResult[];
}

export class SnapshotReplayMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotReplayMismatchError';
  }
}

/** 快照文件唯一序列化口：2 空格缩进 + 末尾换行，录制与回放逐字节对齐靠它。 */
export function serializeSnapshotJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readSnapshotFile(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new SnapshotReplayMismatchError(
      `快照文件缺失或不可读：${filePath}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
}

function readSnapshotJson<T>(filePath: string): T {
  const raw = readSnapshotFile(filePath);
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new SnapshotReplayMismatchError(
      `快照文件不是合法 JSON：${filePath}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
}

function firstDifferentByte(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left.charCodeAt(index) !== right.charCodeAt(index)) return index;
  }
  return limit;
}

function excerpt(value: string, offset: number): string {
  const start = Math.max(0, offset - 32);
  const end = Math.min(value.length, offset + 33);
  return JSON.stringify(value.slice(start, end));
}

function assertSnapshotBytesEqual(label: string, expectedRaw: string, actualRaw: string): void {
  if (expectedRaw === actualRaw) return;
  const offset = firstDifferentByte(expectedRaw, actualRaw);
  throw new SnapshotReplayMismatchError([
    `${label} 逐字节不等，第一处差异在 byte ${offset}`,
    `快照(${expectedRaw.length} bytes): ${excerpt(expectedRaw, offset)}`,
    `当前(${actualRaw.length} bytes): ${excerpt(actualRaw, offset)}`,
  ].join('\n'));
}

/** 假模型响应的 canonical 形态：只留模型可见字节，键序由本函数构造固定。 */
function canonicalizeSnapshotResponse(response: ModelResponse): unknown {
  return {
    type: response.type,
    content: response.content,
    finishReason: response.finishReason ?? null,
    actualProvider: response.actualProvider ?? null,
    actualModel: response.actualModel ?? null,
    toolCalls: (response.toolCalls ?? []).map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    })),
    contentParts: response.contentParts ?? [],
    usage: {
      inputTokens: response.usage?.inputTokens ?? null,
      outputTokens: response.usage?.outputTokens ?? null,
    },
  };
}

function snapshotBlobsReaders(blobs: SnapshotBlobs): RequestReplayContentReaders {
  return {
    getSystemPrompt: (hash) => {
      const content = blobs.systemPrompts[hash];
      return content == null ? null : { content };
    },
    getContent: (hash) => blobs.content[hash] ?? null,
    getToolSchema: (hash) => blobs.toolSchemas[hash] ?? null,
  };
}

interface SnapshotCaseFiles {
  index: SnapshotCaseIndex;
  ledgerMessages: Message[];
  blobs: SnapshotBlobs;
}

function readSnapshotCase(caseDir: string): SnapshotCaseFiles {
  const index = readSnapshotJson<SnapshotCaseIndex>(path.join(caseDir, 'index.json'));
  if (index.version !== 1) {
    throw new SnapshotReplayMismatchError(`快照 index 版本不支持：${JSON.stringify(index.version)}（${caseDir}）`);
  }
  if (!Array.isArray(index.turns) || index.turns.length === 0) {
    throw new SnapshotReplayMismatchError(`快照 index turns 为空，门不许空转：${caseDir}`);
  }
  const ledger = readSnapshotJson<{ messages: Message[] }>(path.join(caseDir, 'ledger.json'));
  const blobs = readSnapshotJson<SnapshotBlobs>(path.join(caseDir, 'blobs.json'));
  return { index, ledgerMessages: ledger.messages, blobs };
}

/**
 * 回放单个 turn：重建 → 咬 canonical-request 字节 → 假模型重推导 → 咬
 * expected-response 字节。degraded manifest 返回 skipped-degraded（与
 * verifyRequestReplayBatch 同口径：跳过不算失败，但要计数防静默全跳）。
 */
function replaySnapshotTurn(
  caseDir: string,
  turnId: string,
  caseFiles: SnapshotCaseFiles,
): SnapshotTurnReplayResult {
  const turnDir = path.join(caseDir, turnId);
  const manifest = readSnapshotJson<SnapshotManifest>(path.join(turnDir, 'manifest.json'));
  if (manifest.degraded) {
    return { turnId, status: 'skipped-degraded' };
  }

  const reconstructed = reconstructRequest(
    manifest,
    caseFiles.ledgerMessages,
    snapshotBlobsReaders(caseFiles.blobs),
  );

  const expectedRequestRaw = readSnapshotFile(path.join(turnDir, 'canonical-request.json'));
  const actualRequestRaw = serializeSnapshotJson({
    canonicalMessages: reconstructed.canonicalMessages,
    canonicalTools: reconstructed.canonicalTools,
  });
  assertSnapshotBytesEqual(`${turnId} canonical-request`, expectedRequestRaw, actualRequestRaw);

  const derived = deriveSnapshotResponse(reconstructed, caseFiles.index);
  const expectedResponseRaw = readSnapshotFile(path.join(turnDir, 'expected-response.json'));
  const actualResponseRaw = serializeSnapshotJson(canonicalizeSnapshotResponse(derived));
  assertSnapshotBytesEqual(`${turnId} expected-response`, expectedResponseRaw, actualResponseRaw);

  return { turnId, status: 'verified' };
}

function deriveSnapshotResponse(
  reconstructed: ReconstructedRequest,
  index: SnapshotCaseIndex,
): ModelResponse {
  // 假模型按消息文本里的 marker 路由，重建出的 ModelMessage[] 与录制时逐字节
  // 一致 ⇒ 推导出的响应必然等于当初会话真收到的那一份；若假模型路由逻辑变了
  // 而快照没同 PR 重录，这里咬字节变红。
  return buildE2ELocalAgentModelResponse(
    reconstructed.messages,
    reconstructed.tools as unknown as ToolDefinition[],
    index.model as ModelConfig,
    undefined,
    index.fakeModelEnv as NodeJS.ProcessEnv,
  );
}

export function replaySnapshotCase(caseDir: string): SnapshotCaseReplayResult {
  const caseFiles = readSnapshotCase(caseDir);
  const turns: SnapshotTurnReplayResult[] = [];
  let verified = 0;
  let skippedDegraded = 0;
  for (const turnId of caseFiles.index.turns) {
    const result = replaySnapshotTurn(caseDir, turnId, caseFiles);
    turns.push(result);
    if (result.status === 'verified') verified += 1;
    else skippedDegraded += 1;
  }
  return { caseId: caseFiles.index.caseId, verified, skippedDegraded, turns };
}

// ---------------------------------------------------------------------------
// 录制侧：规范化（id/时间戳）与 blob 采集。回放只用上面的只读路径；以下函数
// 的消费者是 --record CLI 与单测。
// ---------------------------------------------------------------------------

const PROJECTION_ID_SEPARATOR = '::tool-result::';

/** 账本消息 id → 快照稳定 id（msg-01…，按首次出现序）。 */
export function buildSnapshotIdMap(ledgerMessages: readonly Message[]): Map<string, string> {
  const idMap = new Map<string, string>();
  for (const message of ledgerMessages) {
    if (!idMap.has(message.id)) {
      idMap.set(message.id, `msg-${String(idMap.size + 1).padStart(2, '0')}`);
    }
  }
  return idMap;
}

function mapSnapshotId(idMap: Map<string, string>, id: string, label: string): string {
  const mapped = idMap.get(id);
  if (!mapped) throw new SnapshotReplayMismatchError(`${label} 引用了账本外 id：${id}`);
  return mapped;
}

function mapProjectionId(idMap: Map<string, string>, id: string, label: string): string {
  const separator = id.indexOf(PROJECTION_ID_SEPARATOR);
  if (separator < 0) return mapSnapshotId(idMap, id, label);
  const origin = mapSnapshotId(idMap, id.slice(0, separator), label);
  return `${origin}${id.slice(separator)}`;
}

/**
 * 账本白名单规范化：只留 projectLedgerMessage 消费的字段（+ id/role），
 * 时间戳归零。toolCalls/toolResults 只留投影读的字段——duration、artifact
 * 时间戳、sessionId 等录制现场痕迹天然不确定（2026-09-07 双录 diff 抓到），
 * 且投影根本不读它们。录制后立刻自验回放，白名单缺字段会在录制当下红，
 * 不许带病入库。
 */
export function normalizeLedgerForSnapshot(
  ledgerMessages: readonly Message[],
  idMap: Map<string, string>,
): Message[] {
  return ledgerMessages.map((message) => {
    // 带 toolResults 的 tool 消息，其 content 是结果数组的序列化拷贝，内含
    // duration/createdAt/sessionId 等录制现场痕迹；投影（projectLedgerMessage）
    // 只读 toolResults，content 是死重——归零，否则双录必不同字节
    // （2026-09-07 diff 抓到 duration 29↔28、createdAt、sessionId 漂移）。
    const contentRedundant = message.role === 'tool' && Boolean(message.toolResults?.length);
    return {
      id: mapSnapshotId(idMap, message.id, 'ledger.json'),
      role: message.role,
      content: contentRedundant ? '' : message.content,
      timestamp: 0,
      ...(message.toolCalls
        ? {
          toolCalls: message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })),
        }
        : {}),
      ...(message.toolResults
        ? {
          toolResults: message.toolResults.map((result) => ({
            toolCallId: result.toolCallId,
            success: result.success,
            output: result.output,
            error: result.error,
          })),
        }
        : {}),
      ...(message.thinking ? { thinking: message.thinking } : {}),
      ...(message.attachments ? { attachments: message.attachments } : {}),
      ...(message.responsesOutput ? { responsesOutput: message.responsesOutput } : {}),
    } as Message;
  });
}

/** manifest 规范化：requestId 与账本 id 引用全部换成稳定 id，内容哈希不动。 */
export function normalizeManifestForSnapshot(
  manifest: SnapshotManifest,
  idMap: Map<string, string>,
  requestId: string,
): SnapshotManifest {
  return {
    ...manifest,
    requestId,
    messageRefs: manifest.messageRefs.map((ref) => (
      ref.kind === 'ledger_message'
        ? { kind: 'ledger_message', messageId: mapSnapshotId(idMap, ref.messageId, `manifest ${requestId}`) }
        : ref
    )),
    compactionReplacements: manifest.compactionReplacements.map((replacement) => ({
      replacedMessageIds: replacement.replacedMessageIds.map((id) => (
        mapProjectionId(idMap, id, `manifest ${requestId} compactionReplacements`)
      )),
      replacementContentHash: replacement.replacementContentHash,
    })),
  };
}

export interface SnapshotBlobSources {
  getContent(hash: string): string | null;
  getSystemPrompt(hash: string): { content: string } | null;
  getToolSchema(hash: string): string | null;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function collectVerified(
  bucket: Record<string, string>,
  hash: string,
  value: string | null,
  label: string,
): void {
  if (value == null) {
    throw new SnapshotReplayMismatchError(`${label}缺内容：hash ${hash} 在录制现场的内容库里取不到`);
  }
  if (sha256(value) !== hash) {
    throw new SnapshotReplayMismatchError(`${label}内容哈希不符：${hash}`);
  }
  bucket[hash] = value;
}

/** 按 manifest 引用采集全部内容 blob；采完按键排序保证文件字节确定。 */
export function collectSnapshotBlobs(
  manifests: readonly SnapshotManifest[],
  sources: SnapshotBlobSources,
): SnapshotBlobs {
  const content: Record<string, string> = {};
  const systemPrompts: Record<string, string> = {};
  const toolSchemas: Record<string, string> = {};

  for (const manifest of manifests) {
    for (const [index, ref] of manifest.messageRefs.entries()) {
      const label = `${manifest.requestId} messageRefs[${index}]`;
      if (ref.kind === 'system_prompt') {
        const entry = sources.getSystemPrompt(ref.contentHash);
        collectVerified(systemPrompts, ref.contentHash, entry?.content ?? null, `${label} system_prompt_cache`);
        continue;
      }
      if (ref.kind !== 'content') continue;
      if (ref.attachmentBlobs?.length) {
        throw new SnapshotReplayMismatchError(
          `${label}含附件 blob，快照语料 v1 不支持图片附件路径（语料用例本就不该有）`,
        );
      }
      if (ref.blocks) {
        for (const block of ref.blocks) {
          collectVerified(content, block.contentHash, sources.getContent(block.contentHash), `${label} content_cache block`);
        }
        continue;
      }
      collectVerified(content, ref.contentHash, sources.getContent(ref.contentHash), `${label} content_cache`);
    }
    for (const replacement of manifest.compactionReplacements) {
      collectVerified(
        content,
        replacement.replacementContentHash,
        sources.getContent(replacement.replacementContentHash),
        `${manifest.requestId} compactionReplacements`,
      );
    }
    collectVerified(
      toolSchemas,
      manifest.toolSchemaHash,
      sources.getToolSchema(manifest.toolSchemaHash),
      `${manifest.requestId} tool_schema_cache`,
    );
  }

  return {
    content: sortRecordKeys(content),
    systemPrompts: sortRecordKeys(systemPrompts),
    toolSchemas: sortRecordKeys(toolSchemas),
  };
}

/**
 * 录制完成后立即自验：落盘字节必须能当场回放通过（白名单/规范化的钉测试）。
 *
 * 口径边界（ai-review #1721 Nit 2 成文）：本函数与回放器共用 reconstructRequest /
 * deriveSnapshotResponse，因此录制自验只证明「往返一致」——manifest + 账本 +
 * blob 能被同一份重建代码读回来；它**不**证明「与现场一致」——不证明落盘字节
 * 等于推理现场真实跨过引擎边界的那一份。现场一致性由两道既有闸守：
 *   1. 生产录制侧：request_manifest 在 inference.ts 记录的是实发视图，哈希对齐
 *      content_cache（哈希不符即 degraded，录制器遇 degraded 直接 fail-loud）；
 *   2. 现场对照挂点：acceptance:request-replay（request-replay-smoke.ts）把
 *      重建视图与 ModelRouter 实发消息逐字节咬住（双向变异控制），
 *      本快照体系负责「跨时间重放」，它负责「现场 vs 重建」。
 * 若日后要给快照本体加现场对照，挂点在 deriveSnapshotResponse：把录制时真收到的
 * ModelResponse（需可注入的 router 包装点，目前不存在）与推导值并排落盘比对。
 */
export function buildSnapshotTurnFiles(
  manifest: SnapshotManifest,
  ledgerMessages: readonly Message[],
  blobs: SnapshotBlobs,
  index: SnapshotCaseIndex,
): { manifestRaw: string; canonicalRequestRaw: string; expectedResponseRaw: string } {
  const reconstructed = reconstructRequest(manifest, ledgerMessages, snapshotBlobsReaders(blobs));
  return {
    manifestRaw: serializeSnapshotJson(manifest),
    canonicalRequestRaw: serializeSnapshotJson({
      canonicalMessages: reconstructed.canonicalMessages,
      canonicalTools: reconstructed.canonicalTools,
    }),
    expectedResponseRaw: serializeSnapshotJson(
      canonicalizeSnapshotResponse(deriveSnapshotResponse(reconstructed, index)),
    ),
  };
}

// ---------------------------------------------------------------------------
// 录制侧：脱敏擦洗。系统提示词的 <env> 块会带 Home Directory、自我认知块会带
// 仓绝对路径（2026-09-07 首录抓到 /Users/<user> 与 worktree 路径进快照）——
// AGENTS.md §5.8 禁绝对家目录路径进快照。擦洗在内容哈希**之后**重算哈希并
// 全量回写 manifest 引用，回放侧 reconstructRequest 的哈希自校验不受影响。
// ---------------------------------------------------------------------------

export interface SnapshotScrubRule {
  from: string;
  to: string;
}

/** 长前缀优先（repoRoot/dataDir 都含 homedir/tmpdir 前缀，先替长的防半截替换）。 */
export function buildSnapshotScrubRules(input: { repoRoot: string; dataDir: string }): SnapshotScrubRule[] {
  return [
    // macOS 工具执行层会把路径 realpath 成 /private/var/...（tmpdir() 给的是
    // /var/...），两个前缀都得替，否则 Bash/Write 结果里残留 /private<…> 半截
    // （2026-09-07 双录 diff 抓到）；Linux 上该规则空转。
    { from: path.join('/private', input.dataDir), to: '<RECORD_DATA_DIR>' },
    { from: input.repoRoot, to: '<REPO_ROOT>' },
    { from: input.dataDir, to: '<RECORD_DATA_DIR>' },
    { from: path.join('/private', os.homedir()), to: '<HOME>' },
    { from: os.homedir(), to: '<HOME>' },
  ]
    .filter((rule) => rule.from.length > 1)
    .sort((left, right) => right.from.length - left.from.length);
}

function scrubSnapshotText(text: string, rules: readonly SnapshotScrubRule[]): string {
  let out = text;
  for (const rule of rules) {
    out = out.split(rule.from).join(rule.to);
  }
  return out;
}

function sortRecordKeys(bucket: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(bucket).sort(([left], [right]) => (left < right ? -1 : 1)),
  );
}

export interface SnapshotRecordingScrubInput {
  /** 已过 normalizeManifestForSnapshot 的 manifest（id 稳定，哈希还是擦洗前的）。 */
  manifests: SnapshotManifest[];
  /** 已过 normalizeLedgerForSnapshot 的账本。 */
  ledgerMessages: Message[];
  /** 按**擦洗前**哈希索引的原始 blob（collectSnapshotBlobs 产物）。 */
  blobs: SnapshotBlobs;
  fakeModelEnv: Record<string, string>;
  rules: readonly SnapshotScrubRule[];
}

export interface ScrubbedSnapshotRecording {
  manifests: SnapshotManifest[];
  ledgerMessages: Message[];
  blobs: SnapshotBlobs;
  fakeModelEnv: Record<string, string>;
}

function scrubJsonValue(value: unknown, rules: readonly SnapshotScrubRule[]): unknown {
  if (typeof value === 'string') return scrubSnapshotText(value, rules);
  if (Array.isArray(value)) return value.map((entry) => scrubJsonValue(entry, rules));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, scrubJsonValue(entry, rules)]),
    );
  }
  return value;
}

export function scrubSnapshotRecording(input: SnapshotRecordingScrubInput): ScrubbedSnapshotRecording {
  const hashMap = new Map<string, string>();
  const scrubBucket = (bucket: Record<string, string>, label: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [hash, content] of Object.entries(bucket)) {
      const scrubbed = scrubSnapshotText(content, input.rules);
      const scrubbedHash = sha256(scrubbed);
      const existing = hashMap.get(hash);
      if (existing && existing !== scrubbedHash) {
        throw new SnapshotReplayMismatchError(`${label}哈希映射冲突：${hash}`);
      }
      hashMap.set(hash, scrubbedHash);
      out[scrubbedHash] = scrubbed;
    }
    return sortRecordKeys(out);
  };

  const blobs: SnapshotBlobs = {
    content: scrubBucket(input.blobs.content, 'content'),
    systemPrompts: scrubBucket(input.blobs.systemPrompts, 'systemPrompts'),
    toolSchemas: scrubBucket(input.blobs.toolSchemas, 'toolSchemas'),
  };

  const remapHash = (hash: string, label: string): string => {
    const mapped = hashMap.get(hash);
    if (!mapped) throw new SnapshotReplayMismatchError(`${label}引用了未采集的 blob 哈希：${hash}`);
    return mapped;
  };

  const manifests = input.manifests.map((manifest) => ({
    ...manifest,
    toolSchemaHash: remapHash(manifest.toolSchemaHash, `${manifest.requestId} toolSchemaHash`),
    messageRefs: manifest.messageRefs.map((ref, refIndex) => {
      const label = `${manifest.requestId} messageRefs[${refIndex}]`;
      if (ref.kind === 'system_prompt') {
        return { ...ref, contentHash: remapHash(ref.contentHash, label) };
      }
      if (ref.kind !== 'content') return ref;
      if (ref.blocks) {
        // 块形态的整体 contentHash 不进 blobs（重建时拼块重验），擦洗后拼块重算。
        const blocks = ref.blocks.map((block) => {
          const scrubbed = blobs.content[remapHash(block.contentHash, `${label} blocks`)];
          return { contentHash: remapHash(block.contentHash, label), bytes: Buffer.byteLength(scrubbed, 'utf-8') };
        });
        const joinedHash = sha256(blocks.map((block) => blobs.content[block.contentHash]).join(''));
        return { ...ref, contentHash: joinedHash, blocks };
      }
      return {
        ...ref,
        contentHash: remapHash(ref.contentHash, label),
        ...(ref.structureHash ? { structureHash: remapHash(ref.structureHash, label) } : {}),
      };
    }),
    compactionReplacements: manifest.compactionReplacements.map((replacement) => ({
      ...replacement,
      replacementContentHash: remapHash(replacement.replacementContentHash, `${manifest.requestId} compactionReplacements`),
    })),
  }));

  const ledgerMessages = input.ledgerMessages.map((message) => (
    scrubJsonValue(message, input.rules) as Message
  ));

  const fakeModelEnv = Object.fromEntries(
    Object.entries(input.fakeModelEnv)
      .map(([key, value]) => [key, scrubSnapshotText(value, input.rules)]),
  );

  return { manifests, ledgerMessages, blobs, fakeModelEnv };
}
