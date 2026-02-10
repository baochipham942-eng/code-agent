// ============================================================================
// Video Verifier - 视频生成任务验证器
// ============================================================================
// 检查：file_created + file_not_empty + file_readable (magic bytes)
// 对标 ImageVerifier，补全视频生成的质量门禁
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../services/infra/logger';
import type { TaskVerifier, VerificationContext, VerificationResult, VerificationCheck } from './verifierRegistry';
import type { TaskAnalysis } from '../hybrid/taskRouter';

const logger = createLogger('VideoVerifier');

// Magic bytes for common video formats
const VIDEO_MAGIC_BYTES: Record<string, { offset: number; bytes: Buffer }> = {
  // MP4/MOV: ftyp box at offset 4
  '.mp4': { offset: 4, bytes: Buffer.from('ftyp', 'ascii') },
  '.mov': { offset: 4, bytes: Buffer.from('ftyp', 'ascii') },
  // AVI: RIFF header
  '.avi': { offset: 0, bytes: Buffer.from('RIFF', 'ascii') },
  // MKV/WebM: EBML header (0x1A 0x45 0xDF 0xA3)
  '.mkv': { offset: 0, bytes: Buffer.from([0x1A, 0x45, 0xDF, 0xA3]) },
  '.webm': { offset: 0, bytes: Buffer.from([0x1A, 0x45, 0xDF, 0xA3]) },
};

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

/**
 * Video task verifier
 *
 * Performs deterministic checks on video generation outputs:
 * 1. file_created — Video file exists
 * 2. file_not_empty — File size > 10KB (video files are larger than images)
 * 3. file_readable — File header matches expected format (magic bytes)
 */
export class VideoVerifier implements TaskVerifier {
  id = 'video-verifier';
  taskType = 'video' as const;

  canVerify(taskAnalysis: TaskAnalysis): boolean {
    return taskAnalysis.taskType === 'video';
  }

  async verify(context: VerificationContext): Promise<VerificationResult> {
    const checks: VerificationCheck[] = [];
    const videoFiles = this.findVideoFiles(context);

    if (videoFiles.length === 0) {
      // video_generate 是异步任务，可能还在生成中
      // 检查 tool call 是否成功调用了 video_generate
      const videoToolCalled = context.toolCalls?.some(
        tc => tc.name === 'video_generate' && tc.result?.success
      );

      if (videoToolCalled) {
        checks.push({
          name: 'file_created',
          passed: true,
          score: 0.8,
          message: 'video_generate tool called successfully (async task submitted)',
          metadata: { asyncPending: true },
        });
      } else {
        checks.push({
          name: 'file_created',
          passed: false,
          score: 0,
          message: 'No video files found and video_generate tool was not called successfully',
        });
      }
    } else {
      for (const file of videoFiles) {
        checks.push(this.checkFileCreated(file));
        checks.push(this.checkFileNotEmpty(file));
        checks.push(this.checkFileReadable(file));
      }
    }

    const totalScore = checks.reduce((sum, c) => sum + c.score, 0);
    const score = checks.length > 0 ? totalScore / checks.length : 0;
    const passed = checks.every(c => c.passed) || score >= 0.7;

    const suggestions: string[] = [];
    for (const check of checks) {
      if (!check.passed) {
        suggestions.push(`Fix: ${check.name} — ${check.message}`);
      }
    }

    return {
      passed,
      score,
      checks,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
      taskType: 'video',
      durationMs: 0,
    };
  }

  private checkFileCreated(filePath: string): VerificationCheck {
    const exists = fs.existsSync(filePath);
    return {
      name: 'file_created',
      passed: exists,
      score: exists ? 1 : 0,
      message: exists
        ? `Video file exists: ${path.basename(filePath)}`
        : `Video file not found: ${path.basename(filePath)}`,
      metadata: { path: filePath },
    };
  }

  private checkFileNotEmpty(filePath: string): VerificationCheck {
    if (!fs.existsSync(filePath)) {
      return { name: 'file_not_empty', passed: false, score: 0, message: 'File does not exist' };
    }

    const stats = fs.statSync(filePath);
    // 视频文件通常 >10KB（5 秒视频至少几百 KB）
    const isReasonableSize = stats.size > 10240;

    return {
      name: 'file_not_empty',
      passed: isReasonableSize,
      score: isReasonableSize ? 1 : stats.size > 0 ? 0.3 : 0,
      message: isReasonableSize
        ? `Video file size: ${(stats.size / 1024).toFixed(1)} KB`
        : `Video file too small: ${stats.size} bytes (expected >10KB)`,
      metadata: { size: stats.size },
    };
  }

  private checkFileReadable(filePath: string): VerificationCheck {
    if (!fs.existsSync(filePath)) {
      return { name: 'file_readable', passed: false, score: 0, message: 'File does not exist' };
    }

    const ext = path.extname(filePath).toLowerCase();
    const magicSpec = VIDEO_MAGIC_BYTES[ext];

    if (!magicSpec) {
      return {
        name: 'file_readable',
        passed: true,
        score: 0.7,
        message: `Video format ${ext} not validated (unsupported magic bytes check)`,
      };
    }

    try {
      const fd = fs.openSync(filePath, 'r');
      const readLength = magicSpec.offset + magicSpec.bytes.length;
      const headerBuffer = Buffer.alloc(readLength);
      fs.readSync(fd, headerBuffer, 0, readLength, 0);
      fs.closeSync(fd);

      const actual = headerBuffer.subarray(magicSpec.offset, magicSpec.offset + magicSpec.bytes.length);
      const isValid = actual.equals(magicSpec.bytes);

      return {
        name: 'file_readable',
        passed: isValid,
        score: isValid ? 1 : 0,
        message: isValid
          ? `Valid ${ext.slice(1).toUpperCase()} file (magic bytes match)`
          : `Invalid ${ext.slice(1).toUpperCase()} file (magic bytes mismatch)`,
        metadata: {
          expected: magicSpec.bytes.toString('hex'),
          actual: actual.toString('hex'),
        },
      };
    } catch (error) {
      return {
        name: 'file_readable',
        passed: false,
        score: 0,
        message: `File read error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Find video files from context
   */
  private findVideoFiles(context: VerificationContext): string[] {
    const files: string[] = [];

    // From modified files
    if (context.modifiedFiles) {
      for (const f of context.modifiedFiles) {
        if (VIDEO_EXTENSIONS.includes(path.extname(f).toLowerCase())) {
          const fullPath = path.isAbsolute(f) ? f : path.join(context.workingDirectory, f);
          if (fs.existsSync(fullPath)) files.push(fullPath);
        }
      }
    }

    // From tool call results
    if (context.toolCalls) {
      for (const call of context.toolCalls) {
        if (!call.result?.success || !call.result.output) continue;
        const extJoin = VIDEO_EXTENSIONS.map(e => e.slice(1)).join('|');
        const pathPattern = new RegExp(`[^\\s'"]+\\.(${extJoin})\\b`, 'gi');
        const matches = call.result.output.match(pathPattern) || [];
        for (const match of matches) {
          const fullPath = path.isAbsolute(match) ? match : path.join(context.workingDirectory, match);
          if (fs.existsSync(fullPath) && !files.includes(fullPath)) files.push(fullPath);
        }
      }
    }

    // From agent output
    const extJoin = VIDEO_EXTENSIONS.map(e => e.slice(1)).join('|');
    const pattern = new RegExp(`[^\\s'"]+\\.(${extJoin})\\b`, 'gi');
    const outputMatches = context.agentOutput.match(pattern) || [];
    for (const match of outputMatches) {
      const fullPath = path.isAbsolute(match) ? match : path.join(context.workingDirectory, match);
      if (fs.existsSync(fullPath) && !files.includes(fullPath)) files.push(fullPath);
    }

    return files;
  }
}
