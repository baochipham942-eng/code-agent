// ============================================================================
// Image Verifier - 图像生成任务验证器
// ============================================================================
// 检查：file_created + file_not_empty + file_readable (magic bytes)
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../services/infra/logger';
import type { TaskVerifier, VerificationContext, VerificationResult, VerificationCheck } from './verifierRegistry';
import type { TaskAnalysis } from '../hybrid/taskRouter';

const logger = createLogger('ImageVerifier');

// Magic bytes for common image formats
const IMAGE_MAGIC_BYTES: Record<string, Buffer> = {
  '.png': Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  '.jpg': Buffer.from([0xFF, 0xD8, 0xFF]),
  '.jpeg': Buffer.from([0xFF, 0xD8, 0xFF]),
  '.gif': Buffer.from([0x47, 0x49, 0x46]),
  '.webp': Buffer.from([0x52, 0x49, 0x46, 0x46]),
  '.bmp': Buffer.from([0x42, 0x4D]),
};

// SVG is text-based, check for opening tag
const SVG_PATTERN = /<svg[\s>]/i;

/**
 * Image task verifier
 *
 * Performs deterministic checks on image generation outputs:
 * 1. file_created — Image file exists (.png/.jpg/.svg/.gif/.webp)
 * 2. file_not_empty — File size > 1KB
 * 3. file_readable — File header matches expected format (magic bytes)
 */
export class ImageVerifier implements TaskVerifier {
  id = 'image-verifier';
  taskType = 'image' as const;

  canVerify(taskAnalysis: TaskAnalysis): boolean {
    return taskAnalysis.taskType === 'image';
  }

  async verify(context: VerificationContext): Promise<VerificationResult> {
    const checks: VerificationCheck[] = [];
    const imageFiles = this.findImageFiles(context);

    if (imageFiles.length === 0) {
      checks.push({
        name: 'file_created',
        passed: false,
        score: 0,
        message: 'No image files found in modified files or tool call results',
      });
    } else {
      for (const file of imageFiles) {
        // Check 1: File created
        checks.push(this.checkFileCreated(file));

        // Check 2: File not empty
        checks.push(this.checkFileNotEmpty(file));

        // Check 3: File readable (magic bytes)
        checks.push(this.checkFileReadable(file));
      }
    }

    // Calculate overall score
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
      taskType: 'image',
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
        ? `Image file exists: ${path.basename(filePath)}`
        : `Image file not found: ${path.basename(filePath)}`,
      metadata: { path: filePath },
    };
  }

  private checkFileNotEmpty(filePath: string): VerificationCheck {
    if (!fs.existsSync(filePath)) {
      return {
        name: 'file_not_empty',
        passed: false,
        score: 0,
        message: 'File does not exist',
      };
    }

    const stats = fs.statSync(filePath);
    const isReasonableSize = stats.size > 1024; // > 1KB

    return {
      name: 'file_not_empty',
      passed: isReasonableSize,
      score: isReasonableSize ? 1 : stats.size > 0 ? 0.3 : 0,
      message: isReasonableSize
        ? `Image file size: ${(stats.size / 1024).toFixed(1)} KB`
        : `Image file too small: ${stats.size} bytes (expected >1KB)`,
      metadata: { size: stats.size },
    };
  }

  private checkFileReadable(filePath: string): VerificationCheck {
    if (!fs.existsSync(filePath)) {
      return {
        name: 'file_readable',
        passed: false,
        score: 0,
        message: 'File does not exist',
      };
    }

    const ext = path.extname(filePath).toLowerCase();

    try {
      // SVG: text-based format
      if (ext === '.svg') {
        const content = fs.readFileSync(filePath, 'utf-8');
        const isSvg = SVG_PATTERN.test(content);
        return {
          name: 'file_readable',
          passed: isSvg,
          score: isSvg ? 1 : 0,
          message: isSvg ? 'Valid SVG file' : 'File does not contain valid SVG markup',
        };
      }

      // Binary formats: check magic bytes
      const expectedMagic = IMAGE_MAGIC_BYTES[ext];
      if (!expectedMagic) {
        return {
          name: 'file_readable',
          passed: true,
          score: 0.7,
          message: `Image format ${ext} not validated (unsupported magic bytes check)`,
        };
      }

      const fd = fs.openSync(filePath, 'r');
      const headerBuffer = Buffer.alloc(expectedMagic.length);
      fs.readSync(fd, headerBuffer, 0, expectedMagic.length, 0);
      fs.closeSync(fd);

      const isValid = headerBuffer.subarray(0, expectedMagic.length).equals(expectedMagic);

      return {
        name: 'file_readable',
        passed: isValid,
        score: isValid ? 1 : 0,
        message: isValid
          ? `Valid ${ext.slice(1).toUpperCase()} file (magic bytes match)`
          : `Invalid ${ext.slice(1).toUpperCase()} file (magic bytes mismatch)`,
        metadata: {
          expected: expectedMagic.toString('hex'),
          actual: headerBuffer.toString('hex'),
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
   * Find image files from context
   */
  private findImageFiles(context: VerificationContext): string[] {
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'];
    const files: string[] = [];

    // From modified files
    if (context.modifiedFiles) {
      for (const f of context.modifiedFiles) {
        const ext = path.extname(f).toLowerCase();
        if (imageExtensions.includes(ext)) {
          const fullPath = path.isAbsolute(f) ? f : path.join(context.workingDirectory, f);
          if (fs.existsSync(fullPath)) {
            files.push(fullPath);
          }
        }
      }
    }

    // From tool call results
    if (context.toolCalls) {
      for (const call of context.toolCalls) {
        if (!call.result?.success || !call.result.output) continue;
        const output = call.result.output;

        // Extract image file paths
        const pathPattern = new RegExp(`[^\\s'"]+\\.(${imageExtensions.map(e => e.slice(1)).join('|')})\\b`, 'gi');
        const matches = output.match(pathPattern) || [];
        for (const match of matches) {
          const fullPath = path.isAbsolute(match) ? match : path.join(context.workingDirectory, match);
          if (fs.existsSync(fullPath) && !files.includes(fullPath)) {
            files.push(fullPath);
          }
        }
      }
    }

    // From agent output
    const imgPattern = new RegExp(`[^\\s'"]+\\.(${imageExtensions.map(e => e.slice(1)).join('|')})\\b`, 'gi');
    const outputMatches = context.agentOutput.match(imgPattern) || [];
    for (const match of outputMatches) {
      const fullPath = path.isAbsolute(match) ? match : path.join(context.workingDirectory, match);
      if (fs.existsSync(fullPath) && !files.includes(fullPath)) {
        files.push(fullPath);
      }
    }

    return files;
  }
}
