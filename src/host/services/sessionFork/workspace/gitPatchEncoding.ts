import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

import { AnchorEvidenceError } from './anchorEvidence';
import { WorkspaceCommandError } from './commandRunner';

type IsolatedWorkspaceErrorCode =
  | 'INVALID_DESTINATION'
  | 'INTENT_CONFLICT'
  | 'WORKSPACE_BUSY'
  | 'WORKSPACE_PREPARATION_FAILED'
  | 'WORKSPACE_VERIFICATION_FAILED'
  | 'WORKSPACE_CLEANUP_FAILED';

export class IsolatedWorkspaceError extends Error {
  constructor(
    public readonly code: IsolatedWorkspaceErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'IsolatedWorkspaceError';
  }
}

const GIT_BASE85_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";

export function sha256(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }

export function gitBlobOid(blob: Buffer, objectFormat: string): string {
  const hashAlgorithm = objectFormat === 'sha1'
    ? 'sha1'
    : objectFormat === 'sha256'
      ? 'sha256'
      : null;
  if (!hashAlgorithm) {
    throw new IsolatedWorkspaceError(
      'WORKSPACE_PREPARATION_FAILED',
      `unsupported git object format: ${objectFormat}`,
    );
  }
  return createHash(hashAlgorithm).update(`blob ${blob.byteLength}\0`).update(blob).digest('hex');
}

export function quoteGitPatchPath(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  let quoted = '"';
  for (const byte of bytes) {
    if (byte === 0x22) quoted += '\\"';
    else if (byte === 0x5c) quoted += '\\\\';
    else if (byte === 0x09) quoted += '\\t';
    else if (byte === 0x0a) quoted += '\\n';
    else if (byte === 0x0d) quoted += '\\r';
    else if (byte >= 0x20 && byte <= 0x7e) quoted += String.fromCharCode(byte);
    else quoted += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return `${quoted}"`;
}

export function encodeGitBase85(value: Buffer): string {
  const compressed = deflateSync(value);
  const lines: string[] = [];
  for (let offset = 0; offset < compressed.byteLength; offset += 52) {
    const line = compressed.subarray(offset, Math.min(offset + 52, compressed.byteLength));
    const lengthMarker = line.byteLength <= 26
      ? String.fromCharCode(0x41 + line.byteLength - 1)
      : String.fromCharCode(0x61 + line.byteLength - 27);
    let encoded = '';
    for (let index = 0; index < line.byteLength; index += 4) {
      let accumulator = 0;
      for (let byteOffset = 0; byteOffset < 4; byteOffset += 1) {
        accumulator = (accumulator * 256) + (line[index + byteOffset] ?? 0);
      }
      const digits = new Array<string>(5);
      for (let digit = 4; digit >= 0; digit -= 1) {
        digits[digit] = GIT_BASE85_ALPHABET[accumulator % 85];
        accumulator = Math.floor(accumulator / 85);
      }
      encoded += digits.join('');
    }
    lines.push(`${lengthMarker}${encoded}`);
  }
  return lines.join('\n');
}

export function errorCode(error: unknown): string {
  if (error instanceof AnchorEvidenceError) return error.code;
  if (error instanceof WorkspaceCommandError) return error.code;
  if (error instanceof IsolatedWorkspaceError) return error.code;
  return 'UNKNOWN';
}

export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
