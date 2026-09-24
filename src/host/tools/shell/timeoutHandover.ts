import type { ChildProcess } from 'node:child_process';
import { adoptBackgroundTask } from './backgroundTasks';

const PREVIEW_SIDE_LENGTH = 500;

export interface TimedOutCommandHandoverInput {
  child: ChildProcess;
  command: string;
  cwd: string;
  sessionId?: string;
  toolCallId?: string;
  sandboxed?: boolean;
  abortSignal?: AbortSignal;
  onExit?: () => void;
  stdout: string;
  stderr: string;
  startedAt: number;
}

export interface TimedOutCommandHandoverResult {
  taskId: string;
  outputFile?: string;
  preview: string;
}

function previewOutput(stdout: string, stderr: string): string {
  const output = `${stdout}${stderr ? `\n[stderr] ${stderr}` : ''}`;
  if (output.length <= PREVIEW_SIDE_LENGTH * 2) return output;
  return `${output.slice(0, PREVIEW_SIDE_LENGTH)}\n...[middle omitted; use Process(output) for the full log]...\n${output.slice(-PREVIEW_SIDE_LENGTH)}`;
}

export function handoverTimedOutCommand(
  input: TimedOutCommandHandoverInput,
): TimedOutCommandHandoverResult | null {
  const adopted = adoptBackgroundTask(input.child, input.command, input.cwd, {
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    sandboxed: input.sandboxed,
    abortSignal: input.abortSignal,
    onExit: input.onExit,
    bufferedStdout: input.stdout,
    bufferedStderr: input.stderr,
    startedAt: input.startedAt,
  });
  if (!adopted.success || !adopted.taskId) return null;
  return {
    taskId: adopted.taskId,
    outputFile: adopted.outputFile,
    preview: previewOutput(input.stdout, input.stderr),
  };
}
