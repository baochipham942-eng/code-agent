import type { Message, ToolDefinition } from '@shared/contract';
import type { ModelMessage } from '@host/agent/loopTypes';
import type { TraceEventDataMap } from '@host/agent/runtime/turnTrace';
import { canonicalizeModelMessage } from '@host/agent/runtime/contextAssembly/requestManifestBuilder';
import { buildToolSchemaSnapshot } from '@host/agent/runtime/contextAssembly/inferenceArtifactRepair';
import {
  reconstructRequest,
  type RequestReplayContentReaders,
  type ReconstructedRequest,
} from './requestReplay';

export class RequestReplayMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestReplayMismatchError';
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

function byteDiff(label: string, expected: string, actual: string): RequestReplayMismatchError {
  const offset = firstDifferentByte(expected, actual);
  return new RequestReplayMismatchError([
    `${label} 逐字节不等，第一处差异在 byte ${offset}`,
    `实发(${expected.length} bytes): ${excerpt(expected, offset)}`,
    `重建(${actual.length} bytes): ${excerpt(actual, offset)}`,
  ].join('\n'));
}

export function assertReconstructedRequestMatches(
  actualMessages: readonly ModelMessage[],
  actualToolSchemaJson: string,
  reconstructed: ReconstructedRequest,
): void {
  const actualCanonicalMessages = actualMessages.map(canonicalizeModelMessage);
  if (actualCanonicalMessages.length !== reconstructed.canonicalMessages.length) {
    throw new RequestReplayMismatchError(
      `消息数量不等：实发 ${actualCanonicalMessages.length}，重建 ${reconstructed.canonicalMessages.length}`,
    );
  }
  for (let index = 0; index < actualCanonicalMessages.length; index += 1) {
    const actual = actualCanonicalMessages[index];
    const replayed = reconstructed.canonicalMessages[index];
    if (actual !== replayed) throw byteDiff(`message[${index}]`, actual, replayed);
  }
  if (actualToolSchemaJson !== reconstructed.canonicalTools) {
    throw byteDiff('tools', actualToolSchemaJson, reconstructed.canonicalTools);
  }
}

export interface RequestReplayGateCase {
  manifest: TraceEventDataMap['request_manifest'];
  ledgerMessages: readonly Message[];
  readers: RequestReplayContentReaders;
  actualMessages: readonly ModelMessage[];
  actualTools: ToolDefinition[];
}

export function verifyRequestReplay(input: RequestReplayGateCase): ReconstructedRequest {
  const reconstructed = reconstructRequest(input.manifest, input.ledgerMessages, input.readers);
  const actualToolSchemaJson = buildToolSchemaSnapshot(input.actualTools).schemaJson;
  assertReconstructedRequestMatches(input.actualMessages, actualToolSchemaJson, reconstructed);
  return reconstructed;
}

export function verifyRequestReplayBatch(
  cases: readonly RequestReplayGateCase[],
  report: (message: string) => void = console.log,
): { verified: number; skippedDegraded: number } {
  let verified = 0;
  let skippedDegraded = 0;
  for (const replayCase of cases) {
    if (replayCase.manifest.degraded) {
      skippedDegraded += 1;
      continue;
    }
    verifyRequestReplay(replayCase);
    verified += 1;
  }
  if (skippedDegraded > 0) {
    report(`request replay gate: 跳过 ${skippedDegraded} 轮 degraded`);
  }
  return { verified, skippedDegraded };
}
