import type { ToolCall, ToolResult } from '@shared/contract';

const ARTIFACT_FOLLOW_REFRESH_MS = 1_000;
const ARTIFACT_FOLLOW_INTERACTION_GRACE_MS = 3_000;

const FOLLOWABLE_EXTENSIONS = new Set([
  'html', 'htm', 'md', 'mdx', 'markdown',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg',
]);

const FILE_PATH_TOOLS = new Set([
  'Write', 'write_file', 'Append', 'append_file', 'Edit', 'edit_file',
]);

const IMAGE_OUTPUT_TOOLS = new Set(['image_generate', 'image_process']);

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function resolveFollowableArtifactPath(
  filePath: string,
  workingDirectory: string | null | undefined,
): string | null {
  const withoutQuery = filePath.split(/[?#]/, 1)[0] || filePath;
  const dot = withoutQuery.lastIndexOf('.');
  const extension = dot >= 0 ? withoutQuery.slice(dot + 1).toLowerCase() : '';
  if (!FOLLOWABLE_EXTENSIONS.has(extension)) return null;
  if (filePath.startsWith('/') || !workingDirectory) return filePath;
  return `${workingDirectory.replace(/\/$/, '')}/${filePath.replace(/^\.\//, '')}`;
}

export function artifactPathFromToolStart(
  toolCall: Pick<ToolCall, 'name' | 'arguments'>,
  workingDirectory: string | null | undefined,
): string | null {
  const rawPath = FILE_PATH_TOOLS.has(toolCall.name)
    ? stringField(toolCall.arguments.file_path)
    : IMAGE_OUTPUT_TOOLS.has(toolCall.name)
      ? stringField(toolCall.arguments.output_path)
      : null;
  return rawPath ? resolveFollowableArtifactPath(rawPath, workingDirectory) : null;
}

export function artifactPathFromToolResult(
  result: ToolResult,
  workingDirectory: string | null | undefined,
): string | null {
  const metadata = result.metadata ?? {};
  const rawPath = stringField(result.outputPath)
    ?? stringField(metadata.outputPath)
    ?? stringField(metadata.imagePath)
    ?? stringField(metadata.filePath);
  return rawPath ? resolveFollowableArtifactPath(rawPath, workingDirectory) : null;
}

export function decideArtifactFollowOpen(input: {
  paused: boolean;
  focusInOtherWorkbenchView: boolean;
  lastWorkbenchInteractionAt: number;
  now: number;
}): { activate: boolean; attention: boolean } {
  const recentlyInteracted = input.lastWorkbenchInteractionAt > 0
    && input.now - input.lastWorkbenchInteractionAt < ARTIFACT_FOLLOW_INTERACTION_GRACE_MS;
  const activate = !input.paused && !input.focusInOtherWorkbenchView && !recentlyInteracted;
  return { activate, attention: !activate };
}

export interface TrailingThrottle {
  trigger(): void;
  flush(): void;
  cancel(): void;
}

export function createTrailingThrottle(
  callback: () => void,
  waitMs = ARTIFACT_FOLLOW_REFRESH_MS,
  clock: () => number = Date.now,
  schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> = setTimeout,
  unschedule: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout,
): TrailingThrottle {
  let lastRunAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = () => {
    if (timer) unschedule(timer);
    timer = null;
    lastRunAt = clock();
    callback();
  };

  return {
    trigger() {
      const remaining = waitMs - (clock() - lastRunAt);
      if (remaining <= 0) {
        run();
        return;
      }
      if (!timer) timer = schedule(run, remaining);
    },
    flush: run,
    cancel() {
      if (timer) unschedule(timer);
      timer = null;
    },
  };
}
