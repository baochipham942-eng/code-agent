// 一条 hermetic 回放用例的三层证据。三层各算各的，一层变红不能被另外两层的绿盖住。
// 协议层复用 request-replay 快照的逐字节回放，并要求请求序列仍含当前身份声明。
// 渲染层走现有账本水合 + turn 投影 + 步骤人话 + turnDiff 卡片，不截图。
// 持久层重放假模型 Write 的落盘，再跟账本上的会话终态和审批记录拼在一起。

import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

import type { Message } from '@shared/contract';
import { IDENTITY } from '@host/prompts/identity';
import { persistSnapshotReplayWriteArtifact } from '@host/testing/e2e/e2eLocalAgentModel';
import { projectTurns } from '@renderer/hooks/useTurnProjection';
import { zh } from '@renderer/i18n/zh';
import { formatDisplayPath } from '@renderer/utils/displayPath';
import { humanizeToolStep } from '@renderer/utils/humanizeToolStep';
import { hydrateToolCallResults } from '@renderer/utils/messageHydration';
import { buildTurnFileChanges } from '@renderer/utils/turnDiffSummary';

import {
  replaySnapshotCase,
  serializeSnapshotJson,
  type SnapshotCaseIndex,
} from './snapshotReplay';

const WRITE_TOOLS = new Set(['Write', 'write_file']);
const APPROVAL_KEYS = ['approval', 'approvalRecord', 'approvalDecision'] as const;

interface SnapshotLedgerFile {
  messages: Message[];
}

interface ReplayApprovalRecord {
  toolCallId: string;
  toolName: string;
  decision: string;
}

interface ReplayRenderNode {
  type: string;
  text?: string;
  tool?: string;
  label?: string;
  success?: boolean;
}

function readJsonFile<T>(filePath: string): T {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`快照文件缺失或不可读：${path.basename(filePath)}`, { cause: error });
  }
  return JSON.parse(raw) as T;
}

function readCaseIndex(caseDir: string): SnapshotCaseIndex {
  return readJsonFile<SnapshotCaseIndex>(path.join(caseDir, 'index.json'));
}

function readLedgerMessages(caseDir: string): Message[] {
  const ledger = readJsonFile<SnapshotLedgerFile>(path.join(caseDir, 'ledger.json'));
  if (!Array.isArray(ledger.messages) || ledger.messages.length === 0) {
    throw new Error(`账本为空：${path.basename(caseDir)}`);
  }
  return ledger.messages;
}

function sidecarPath(caseDir: string, kind: 'render' | 'state'): string {
  const index = readCaseIndex(caseDir);
  return path.join(path.dirname(caseDir), `${index.caseId}.${kind}.json`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function decisionText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ['decision', 'outcome', 'status'] as const) {
    const text = record[key];
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return null;
}

function approvalFromMetadata(source: unknown): string | null {
  const record = asRecord(source);
  if (!record) return null;
  for (const key of APPROVAL_KEYS) {
    const decision = decisionText(record[key]);
    if (decision) return decision;
  }
  return null;
}

function collectApprovalRecords(messages: Message[]): ReplayApprovalRecord[] {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      toolNames.set(call.id, call.name);
    }
  }
  const records: ReplayApprovalRecord[] = [];
  const seen = new Set<string>();
  const push = (toolCallId: string, decision: string) => {
    const toolName = toolNames.get(toolCallId) ?? '';
    const key = `${toolCallId}\0${toolName}\0${decision}`;
    if (seen.has(key)) return;
    seen.add(key);
    records.push({ toolCallId, toolName, decision });
  };
  for (const message of messages) {
    const messageDecision = approvalFromMetadata(message.metadata);
    if (messageDecision) {
      const toolCallId = message.toolCalls?.[0]?.id ?? message.toolResults?.[0]?.toolCallId ?? message.id;
      push(toolCallId, messageDecision);
    }
    for (const result of message.toolResults ?? []) {
      const decision = approvalFromMetadata(result.metadata);
      if (decision) push(result.toolCallId, decision);
    }
  }
  records.sort((left, right) => (
    left.toolCallId.localeCompare(right.toolCallId)
    || left.toolName.localeCompare(right.toolName)
    || left.decision.localeCompare(right.decision)
  ));
  return records;
}

function projectRender(caseDir: string): unknown {
  const index = readCaseIndex(caseDir);
  const messages = hydrateToolCallResults(readLedgerMessages(caseDir));
  const projection = projectTurns(messages, index.caseId, false);
  return {
    caseId: index.caseId,
    locale: 'zh',
    turns: projection.turns.map((turn) => ({
      turnNumber: turn.turnNumber,
      status: turn.status,
      nodes: turn.nodes.map((node): ReplayRenderNode => {
        if (node.type === 'tool_call' && node.toolCall) {
          return {
            type: node.type,
            tool: node.toolCall.name,
            label: humanizeToolStep(node.toolCall.name, node.toolCall.args, zh),
            success: node.toolCall.success === true,
          };
        }
        return { type: node.type, text: node.content };
      }),
      fileChanges: buildTurnFileChanges(turn).map((change) => ({
        path: formatDisplayPath(change.filePath),
        added: change.added,
        removed: change.removed,
        isNewFile: change.isNewFile,
      })),
    })),
  };
}

async function projectPersistedState(caseDir: string): Promise<unknown> {
  const index = readCaseIndex(caseDir);
  const messages = readLedgerMessages(caseDir);
  const writes = messages.flatMap((message) => (
    (message.toolCalls ?? []).filter((call) => WRITE_TOOLS.has(call.name))
  ));
  if (writes.length === 0) {
    throw new Error(`持久层：${index.caseId} 的账本没有 Write 调用`);
  }
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'replay-three-layer-'));
  try {
    const artifacts = [];
    for (const call of writes) {
      const rawPath = call.arguments.file_path ?? call.arguments.path;
      const name = typeof rawPath === 'string' && rawPath.trim()
        ? path.basename(rawPath.trim())
        : 'snapshot-write-note.txt';
      const target = path.join(workspace, name);
      await persistSnapshotReplayWriteArtifact(target);
      let bytes: Buffer;
      try {
        bytes = readFileSync(target);
      } catch {
        throw new Error(`持久层：产物未落盘 ${name}`);
      }
      artifacts.push({
        name,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      });
    }
    const last = messages[messages.length - 1];
    return {
      caseId: index.caseId,
      session: {
        messageCount: messages.length,
        lastRole: last.role,
      },
      artifacts,
      approvals: collectApprovalRecords(messages),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function readSidecar(caseDir: string, kind: 'render' | 'state'): string {
  const filePath = sidecarPath(caseDir, kind);
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    throw new Error(`${kind === 'render' ? '渲染层' : '持久层'}：基线缺失 ${path.basename(filePath)}`);
  }
}

function assertLayerBytes(layer: string, expected: string, actual: string): void {
  if (expected === actual) return;
  const limit = Math.min(expected.length, actual.length);
  let offset = limit;
  for (let index = 0; index < limit; index += 1) {
    if (expected.charCodeAt(index) !== actual.charCodeAt(index)) {
      offset = index;
      break;
    }
  }
  const excerpt = (value: string) => JSON.stringify(value.slice(Math.max(0, offset - 40), offset + 40));
  throw new Error([
    `${layer} 与基线不一致，第一处差异在 byte ${offset}`,
    `基线: ${excerpt(expected)}`,
    `当前: ${excerpt(actual)}`,
  ].join('\n'));
}

function textOfCanonicalMessage(message: string): string {
  try {
    const parsed = JSON.parse(message) as { content?: unknown };
    if (typeof parsed.content === 'string') return parsed.content;
    if (Array.isArray(parsed.content)) {
      return parsed.content.map((part) => {
        const record = asRecord(part);
        return typeof record?.text === 'string' ? record.text : '';
      }).join('\n');
    }
  } catch {
    // 有的块本身就是明文，不是再包一层 JSON。
  }
  return message;
}

function canonicalMessagesOf(raw: string): string[] {
  const parsed = JSON.parse(raw) as { canonicalMessages?: unknown };
  if (!Array.isArray(parsed.canonicalMessages)) return [];
  return parsed.canonicalMessages
    .filter((message): message is string => typeof message === 'string')
    .map(textOfCanonicalMessage);
}

/** 协议层：按 turn 顺序咬住已录请求/响应，并要求每条请求仍含当前身份声明。 */
export function assertReplayProtocolLayer(caseDir: string): void {
  const index = readCaseIndex(caseDir);
  let replay;
  try {
    replay = replaySnapshotCase(caseDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`协议层：${message}`, { cause: error });
  }
  if (replay.verified !== index.turns.length || replay.skippedDegraded !== 0) {
    throw new Error(
      `协议层：${index.caseId} 期望 ${index.turns.length} 轮逐字节通过，实际 verified=${replay.verified} skipped=${replay.skippedDegraded}`,
    );
  }
  const identity = String(IDENTITY);
  if (!identity.trim()) {
    throw new Error('协议层：当前身份声明为空');
  }
  for (const turnId of index.turns) {
    const raw = readFileSync(path.join(caseDir, turnId, 'canonical-request.json'), 'utf8');
    const matched = canonicalMessagesOf(raw).some((message) => message.includes(identity));
    if (!matched) {
      throw new Error(`协议层：${turnId} 的请求序列不含当前身份声明`);
    }
  }
}

/** 渲染层：用户可见投影与 `<case>.render.json` 逐字节一致。 */
export function assertReplayRenderLayer(caseDir: string): void {
  const actual = serializeSnapshotJson(projectRender(caseDir));
  assertLayerBytes('渲染层', readSidecar(caseDir, 'render'), actual);
}

/** 持久层：会话终态、产物哈希、审批记录与 `<case>.state.json` 逐字节一致。 */
export async function assertReplayPersistedState(caseDir: string): Promise<void> {
  const actual = serializeSnapshotJson(await projectPersistedState(caseDir));
  assertLayerBytes('持久层', readSidecar(caseDir, 'state'), actual);
}

/** 录制器把渲染层和持久层旁路写到快照目录，与用例目录同级。 */
export async function writeReplayThreeLayerSidecars(caseDir: string): Promise<void> {
  const index = readCaseIndex(caseDir);
  const corpusDir = path.dirname(caseDir);
  await writeFile(
    path.join(corpusDir, `${index.caseId}.render.json`),
    serializeSnapshotJson(projectRender(caseDir)),
    'utf8',
  );
  await writeFile(
    path.join(corpusDir, `${index.caseId}.state.json`),
    serializeSnapshotJson(await projectPersistedState(caseDir)),
    'utf8',
  );
}
