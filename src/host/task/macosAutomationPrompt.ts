import { closeSync, fstatSync, openSync, readSync } from 'fs';
import type { TaskStatus } from '../../shared/contract/backgroundTask';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('MacOsAutomationPrompt');
const OUTPUT_TAIL_MAX_BYTES = 4 * 1024;
const AUTOMATION_COMMAND_PATTERN = /osascript|tell application|system events/i;

export function commandMayAwaitSystemPrompt(command: string): boolean {
  return AUTOMATION_COMMAND_PATTERN.test(command);
}

export function isLikelyUnansweredMacOsAutomationPrompt(args: {
  command: string;
  status: TaskStatus;
  exitCode?: number;
  outputFile?: string;
}): boolean {
  if (args.status !== 'failed' || !commandMayAwaitSystemPrompt(args.command)) {
    return false;
  }

  const outputTail = readOutputTail(args.outputFile);
  if (outputTail === undefined) return false;
  if (outputTail.includes('-1712') || /AppleEvent timed out/i.test(outputTail)) {
    return true;
  }
  return args.exitCode === undefined && outputTail.length === 0;
}

function readOutputTail(outputFile?: string): string | undefined {
  if (!outputFile) return '';

  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(outputFile, 'r');
    const size = fstatSync(fileDescriptor).size;
    const length = Math.min(size, OUTPUT_TAIL_MAX_BYTES);
    if (length === 0) return '';

    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fileDescriptor, buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch (error) {
    logger.warn('Could not inspect shell log for a macOS Automation timeout', {
      reason: 'automation_prompt_log_tail_read_failed',
      outputFile,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch (error) {
        logger.warn('Could not close shell log after macOS Automation timeout inspection', {
          reason: 'automation_prompt_log_close_failed',
          outputFile,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
