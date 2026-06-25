// ============================================================================
// GAP-009: Tool Result Spill — 大工具结果落盘
// ============================================================================

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// mock factory 与测试体各自计算同一确定性路径（避免 vi.hoisted 跨作用域引用）
const testRoot = path.join(os.tmpdir(), `neo-spill-test-${process.pid}`);

vi.mock('../../../src/main/config/configPaths', async () => {
  const osMod = await import('os');
  const pathMod = await import('path');
  return {
    getUserConfigDir: () => pathMod.join(osMod.tmpdir(), `neo-spill-test-${process.pid}`),
  };
});

import {
  spillToolResult,
  spillToolResultArchive,
  buildSpillNotice,
  getToolResultSpillDir,
  readToolResultArchive,
  SPILL_NOTICE_MARKER,
} from '../../../src/main/utils/toolResultSpill';
import { TOOL_RESULT_SPILL } from '../../../src/shared/constants';

describe('toolResultSpill (GAP-009)', () => {
  beforeEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('writes full content to the session tool-results directory and returns the path', () => {
    const content = 'line\n'.repeat(10_000);

    const spillPath = spillToolResult({
      content,
      toolName: 'Bash',
      sessionId: 'session-abc',
      toolCallId: 'call-123',
    });

    expect(spillPath).not.toBeNull();
    expect(spillPath).toContain(path.join('tmp', 'session-abc', 'tool-results'));
    expect(spillPath).toContain('Bash-call-123');
    expect(fs.readFileSync(spillPath!, 'utf-8')).toBe(content);
  });

  it('writes an archive ref sidecar with hash and byte metadata', () => {
    const content = 'archive me\n'.repeat(100);

    const result = spillToolResultArchive({
      content,
      toolName: 'Bash',
      sessionId: 'session-abc',
      toolCallId: 'call-123',
      sourceMessageId: 'msg-1',
      reason: 'unit-test',
    });

    expect(result).not.toBeNull();
    expect(result!.archiveRef.artifactId).toContain('tool_result:session-abc:Bash:call-123');
    expect(result!.archiveRef.bytes).toBe(Buffer.byteLength(content, 'utf-8'));
    expect(result!.archiveRef.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result!.archiveRef.reason).toBe('unit-test');
    expect(result!.archiveRef.sourceMessageId).toBe('msg-1');

    const sidecarPath = `${result!.filePath}.archive.json`;
    expect(fs.existsSync(sidecarPath)).toBe(true);
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
    expect(sidecar).toEqual(result!.archiveRef);
  });

  it('reads archived content only when hash, bytes, and session path match', () => {
    const content = 'verified archive\n'.repeat(100);
    const result = spillToolResultArchive({
      content,
      toolName: 'Bash',
      sessionId: 'session-verify',
      toolCallId: 'call-verify',
    });

    expect(result).not.toBeNull();
    expect(readToolResultArchive(result!.archiveRef)?.content).toBe(content);

    const tamperedHashRef = { ...result!.archiveRef, sha256: '0'.repeat(64) };
    expect(readToolResultArchive(tamperedHashRef)).toBeNull();

    const tamperedBytesRef = { ...result!.archiveRef, bytes: result!.archiveRef.bytes + 1 };
    expect(readToolResultArchive(tamperedBytesRef)).toBeNull();

    const wrongSessionRef = { ...result!.archiveRef, sessionId: 'another-session' };
    expect(readToolResultArchive(wrongSessionRef)).toBeNull();
  });

  it('falls back to the shared directory when sessionId is missing', () => {
    const spillPath = spillToolResult({ content: 'some output', toolName: 'Bash' });

    expect(spillPath).toContain(
      path.join('tmp', TOOL_RESULT_SPILL.SHARED_SESSION, 'tool-results'),
    );
  });

  it('sanitizes unsafe characters in sessionId and toolName', () => {
    const spillPath = spillToolResult({
      content: 'x',
      toolName: 'mcp__github__search/code',
      sessionId: '../escape attempt',
      toolCallId: 'id with spaces',
    });

    expect(spillPath).not.toBeNull();
    // 落盘路径必须仍在 testRoot 下（没有被 ../ 逃逸）
    expect(path.resolve(spillPath!).startsWith(path.resolve(testRoot))).toBe(true);
    expect(spillPath).not.toContain('..');
    expect(path.basename(spillPath!)).not.toContain(' ');
    expect(path.basename(spillPath!)).not.toContain('/');
  });

  it('skips content that already contains a spill notice (no double spill)', () => {
    const alreadySpilled = `truncated output${buildSpillNotice('/some/earlier/path.txt')}`;

    const spillPath = spillToolResult({
      content: alreadySpilled,
      toolName: 'tool-result',
      sessionId: 's1',
    });

    expect(spillPath).toBeNull();
  });

  it('skips empty content and oversized content', () => {
    expect(spillToolResult({ content: '', toolName: 'Bash' })).toBeNull();

    const oversized = 'x'.repeat(TOOL_RESULT_SPILL.MAX_SPILL_BYTES + 1);
    expect(spillToolResult({ content: oversized, toolName: 'Bash' })).toBeNull();
  });

  it('buildSpillNotice contains the marker and the file path', () => {
    const notice = buildSpillNotice('/tmp/foo/bar.txt');

    expect(notice).toContain(SPILL_NOTICE_MARKER);
    expect(notice).toContain('/tmp/foo/bar.txt');
    expect(notice).toMatch(/Read\/Grep/);
  });

  it('buildSpillNotice includes archive id when given an archive ref', () => {
    const result = spillToolResultArchive({
      content: 'notice archive',
      toolName: 'Bash',
      sessionId: 'session-notice',
      toolCallId: 'call-notice',
    });

    expect(result).not.toBeNull();
    const notice = buildSpillNotice(result!.archiveRef);

    expect(notice).toContain(SPILL_NOTICE_MARKER);
    expect(notice).toContain(result!.filePath);
    expect(notice).toContain(`archive=${result!.archiveRef.artifactId}`);
    expect(notice).toContain(`bytes=${result!.archiveRef.bytes}`);
  });

  it('getToolResultSpillDir builds path under the user config dir', () => {
    const dir = getToolResultSpillDir('my-session');

    expect(dir).toBe(
      path.join(testRoot, TOOL_RESULT_SPILL.TMP_DIR, 'my-session', TOOL_RESULT_SPILL.SUBDIR),
    );
  });

  it('never throws when the target directory is not writable (best-effort)', () => {
    // 把 spill 根目录占成一个普通文件，mkdirSync 必然失败
    fs.mkdirSync(testRoot, { recursive: true });
    fs.writeFileSync(path.join(testRoot, TOOL_RESULT_SPILL.TMP_DIR), 'occupied', 'utf-8');

    const spillPath = spillToolResult({ content: 'data', toolName: 'Bash', sessionId: 's1' });

    expect(spillPath).toBeNull();
  });
});
