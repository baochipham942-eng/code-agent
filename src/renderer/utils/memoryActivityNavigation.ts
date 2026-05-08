import type { MemoryActivityEvent } from '../types/runWorkbench';

export interface MemoryActivityFocus {
  filename?: string;
  query: string;
}

function basename(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}

function markdownFilename(value: string | undefined): string | undefined {
  const filename = basename(value?.trim());
  return filename?.toLowerCase().endsWith('.md') ? filename : undefined;
}

export function getMemoryActivityFocus(activity: MemoryActivityEvent): MemoryActivityFocus {
  const filename = markdownFilename(activity.filename)
    || markdownFilename(activity.memoryId)
    || markdownFilename(activity.targetPath);
  const query = filename
    || activity.title.trim()
    || activity.memoryId.trim()
    || activity.reason.trim()
    || 'memory';

  return { filename, query };
}
