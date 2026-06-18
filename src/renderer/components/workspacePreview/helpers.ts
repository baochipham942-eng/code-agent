import type {
  WorkspacePreviewItem,
  WorkspacePreviewKind,
} from '@shared/contract';
import type { DesignBrief } from '@shared/contract/designBrief';
import { directionTokens, type DirectionTokens } from '@/design/direction-tokens';
import type { WorkspacePreviewRuntimeStatus } from '../../utils/workspacePreview';

export function kindLabel(kind: WorkspacePreviewKind): string {
  switch (kind) {
    case 'document': return 'Document';
    case 'spreadsheet': return 'Sheet';
    case 'message_draft': return 'Message';
    case 'calendar_event': return 'Calendar';
    case 'reminder': return 'Reminder';
    case 'web_snapshot': return 'Web';
    case 'image': return 'Image';
    case 'audio': return 'Audio';
    case 'video': return 'Video';
    case 'archive': return 'Archive';
    case 'diff': return 'Diff';
    case 'terminal': return 'Terminal';
    case 'trace': return 'Trace';
    case 'handoff': return 'Continue';
    case 'generic_html': return 'HTML';
    case 'chart': return 'Chart';
    case 'diagram': return 'Diagram';
    case 'question_form': return 'Brief';
    case 'presentation': return 'Presentation';
    case 'design_ppt': return 'Design PPT';
    default: return 'File';
  }
}

function serializePreviewValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getPreviewItemText(item: WorkspacePreviewItem): string {
  return serializePreviewValue(
    item.content?.text
    ?? item.content?.summary
    ?? item.content?.html
    ?? item.content?.json
    ?? item.file?.path
    ?? item.title
  );
}

function getPreviewExportFilename(item: WorkspacePreviewItem): string {
  const baseName = (item.title || item.id || 'artifact')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'artifact';
  const extension = item.content?.html
    ? 'html'
    : item.content?.json
      ? 'json'
      : 'txt';
  return `${baseName}.${extension}`;
}

export function downloadPreviewItem(item: WorkspacePreviewItem): void {
  const content = getPreviewItemText(item);
  const blob = new Blob([content], { type: item.content?.html ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = getPreviewExportFilename(item);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function statusClass(status: WorkspacePreviewItem['status']): string {
  switch (status) {
    case 'draft': return 'bg-amber-500/10 text-amber-300 border-amber-500/20';
    case 'applied':
    case 'sent': return 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20';
    case 'failed': return 'bg-red-500/10 text-red-300 border-red-500/20';
    default: return 'bg-zinc-800 text-zinc-400 border-zinc-700';
  }
}

export function firstFontName(stack: string): string {
  return stack
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .find(Boolean) || 'system-ui';
}

export function tokensForBrief(brief?: DesignBrief): DirectionTokens | undefined {
  if (!brief) return undefined;
  return brief.directionTokens || (brief.direction ? directionTokens[brief.direction] : undefined);
}

export function isRuntimeStatus(value: unknown): value is WorkspacePreviewRuntimeStatus {
  return value === 'booting' || value === 'ready' || value === 'error';
}

export function revisionLabel(item: WorkspacePreviewItem, index: number): string {
  const version = item.revision?.version;
  return version ? `v${version}` : `rev ${index + 1}`;
}

export interface DesignPptArtifactSpec {
  kind?: 'design_ppt';
  title?: string;
  topic?: string;
  theme?: string;
  outputPath?: string;
  slideCodePath?: string;
  promptPath?: string;
  screenshots?: string[];
  slidesCount?: number;
  iterations?: number;
  screenshotError?: string;
}

export function parseDesignPptArtifact(item: WorkspacePreviewItem): DesignPptArtifactSpec | null {
  const raw = item.content?.json;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DesignPptArtifactSpec;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
