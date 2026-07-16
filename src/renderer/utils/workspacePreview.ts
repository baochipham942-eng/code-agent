import type {
  Message,
  PermissionRequest,
  WorkspacePreviewAction,
  WorkspacePreviewItem,
  WorkspacePreviewKind,
  WorkspacePreviewQuality,
  WorkspacePreviewRevision,
  WorkspacePreviewStatus,
} from '@shared/contract';
import { collectToolArtifactsFromMetadata } from '@shared/contract/artifactBlob';
import { normalizeDesignBrief } from '@shared/contract/designBrief';
import type { TurnArtifactOwnershipItem } from '@shared/contract/turnTimeline';
import { getFileExtension, isPreviewable } from './previewable';
import { isReadOnlyArtifactTool } from './artifactOwnership';

const FILE_METADATA_KEYS = [
  'filePath',
  'imagePath',
  'videoPath',
  'outputPath',
  'pptxPath',
  'pdfPath',
];

export interface BuildWorkspacePreviewItemsInput {
  messages: Message[];
  workingDirectory?: string | null;
  pendingPermissionRequest?: PermissionRequest | null;
  currentTurnArtifacts?: {
    turnNumber: number;
    artifactOwnership: TurnArtifactOwnershipItem[];
  } | null;
  limit?: number;
}

export type WorkspacePreviewRuntimeStatus = 'booting' | 'ready' | 'error';

export interface WorkspacePreviewHtmlSrcdocOptions {
  previewId?: string;
}

function scriptJson(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function buildWorkspacePreviewRuntimeScript(previewId: string): string {
  return `<script>
(function() {
  var previewId = ${scriptJson(previewId)};
  function post(message) {
    try {
      window.parent.postMessage(Object.assign({
        channel: 'workspace-preview',
        previewId: previewId
      }, message), '*');
    } catch (_) {}
  }

  function createMemoryStorage() {
    var store = Object.create(null);
    return {
      get length() { return Object.keys(store).length; },
      key: function(index) { return Object.keys(store)[index] || null; },
      getItem: function(key) {
        key = String(key);
        return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
      },
      setItem: function(key, value) { store[String(key)] = String(value); },
      removeItem: function(key) { delete store[String(key)]; },
      clear: function() { store = Object.create(null); }
    };
  }

  function installStorageShim(name) {
    var shim = createMemoryStorage();
    try {
      var current = window[name];
      if (current) {
        var probeKey = '__workspace_preview_probe__';
        current.setItem(probeKey, '1');
        current.removeItem(probeKey);
        return;
      }
    } catch (_) {}

    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get: function() { return shim; }
      });
    } catch (_) {
      try { window[name] = shim; } catch (_) {}
    }
  }

  installStorageShim('localStorage');
  installStorageShim('sessionStorage');

  var lastHeight = 0;
  function measureHeight() {
    var body = document.body;
    var root = document.documentElement;
    var bodyRect = body ? body.getBoundingClientRect() : { bottom: 0, height: 0 };
    var rootRect = root ? root.getBoundingClientRect() : { bottom: 0, height: 0 };
    return Math.ceil(Math.max(
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      bodyRect.bottom,
      bodyRect.height,
      root ? root.scrollHeight : 0,
      root ? root.offsetHeight : 0,
      rootRect.bottom,
      rootRect.height,
      window.innerHeight || 0
    ));
  }

  function reportHeight() {
    var height = measureHeight();
    if (!height || Math.abs(height - lastHeight) < 2) return;
    lastHeight = height;
    post({ type: 'workspace-preview:resize', height: height });
  }

  function nudgeResize() {
    reportHeight();
    requestAnimationFrame(reportHeight);
  }

  window.addEventListener('load', function() {
    post({ type: 'workspace-preview:status', status: 'ready' });
    nudgeResize();
  });
  window.addEventListener('resize', nudgeResize);
  window.addEventListener('error', function(event) {
    post({
      type: 'workspace-preview:status',
      status: 'error',
      message: event && event.message ? String(event.message) : 'Preview runtime error'
    });
  });
  window.addEventListener('unhandledrejection', function(event) {
    post({
      type: 'workspace-preview:status',
      status: 'error',
      message: event && event.reason ? String(event.reason) : 'Preview runtime error'
    });
  });

  try {
    new MutationObserver(nudgeResize).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
  } catch (_) {}

  try {
    new ResizeObserver(nudgeResize).observe(document.documentElement);
    if (document.body) new ResizeObserver(nudgeResize).observe(document.body);
  } catch (_) {}

  try {
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(nudgeResize).catch(function() {});
    }
  } catch (_) {}

  setTimeout(nudgeResize, 50);
  setTimeout(nudgeResize, 200);
  setTimeout(nudgeResize, 500);
  setTimeout(nudgeResize, 1000);
  post({ type: 'workspace-preview:status', status: 'booting' });
})();
</script>`;
}

function workspacePreviewRuntimeHead(previewId: string): string {
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:;\">",
    `<style>
html, body {
  min-height: 100%;
  margin: 0;
  background: #18181b;
  color: #e4e4e7;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body { overflow-wrap: anywhere; }
body:has(> canvas:only-child),
body:has(> svg:only-child) {
  display: grid;
  place-items: center;
  min-height: 100vh;
}
img, svg, canvas, video {
  max-width: 100%;
}
</style>`,
    buildWorkspacePreviewRuntimeScript(previewId),
  ].join('');
}

export function buildWorkspacePreviewHtmlSrcdoc(
  html: string,
  options: WorkspacePreviewHtmlSrcdocOptions = {},
): string {
  const previewId = options.previewId || 'workspace-preview';
  const runtimeHead = workspacePreviewRuntimeHead(previewId);
  const source = html.trim();

  if (!source) {
    return `<!DOCTYPE html><html><head>${runtimeHead}</head><body></body></html>`;
  }

  if (/<head[\s>]/i.test(source)) {
    return source.replace(/<head([^>]*)>/i, `<head$1>${runtimeHead}`);
  }

  if (/<html[\s>]/i.test(source)) {
    return source.replace(/<html([^>]*)>/i, `<html$1><head>${runtimeHead}</head>`);
  }

  return `<!DOCTYPE html><html><head>${runtimeHead}</head><body>${source}</body></html>`;
}

function basename(value: string): string {
  return value.split('/').filter(Boolean).pop() || value;
}

function resolvePath(filePath: string, workingDirectory?: string | null): string {
  const trimmed = filePath.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('/') || trimmed.startsWith('~') || /^[a-z]+:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return workingDirectory ? `${workingDirectory.replace(/\/+$/, '')}/${trimmed}` : trimmed;
}

function fileKindForPath(filePath: string): WorkspacePreviewKind {
  const ext = getFileExtension(filePath);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(ext)) return 'audio';
  if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) return 'video';
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar'].includes(ext)) return 'archive';
  if (['ppt', 'pptx'].includes(ext)) return 'presentation';
  if (['md', 'mdx', 'markdown', 'docx', 'doc', 'pdf', 'txt'].includes(ext)) return 'document';
  if (['csv', 'tsv', 'xlsx', 'xls'].includes(ext)) return 'spreadsheet';
  if (['html', 'htm'].includes(ext)) return 'generic_html';
  return 'file';
}

function actionsForFile(filePath: string): WorkspacePreviewAction[] {
  const actions: WorkspacePreviewAction[] = [
    { kind: 'open', label: 'Open' },
  ];
  if (isPreviewable(filePath)) {
    actions.unshift({ kind: 'open', label: 'Preview' });
  }
  return actions;
}

function statusFromSuccess(success?: boolean): WorkspacePreviewStatus {
  if (success === false) return 'failed';
  return 'ready';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function severityRank(value: unknown): number {
  switch (value) {
    case 'critical':
      return 5;
    case 'high':
      return 4;
    case 'medium':
      return 3;
    case 'low':
      return 2;
    case 'info':
      return 1;
    default:
      return 0;
  }
}

function isActiveIssueStatus(value: unknown): boolean {
  return value === 'open' || value === 'accepted' || value === 'in_progress';
}

function normalizeQualityStatus(value: unknown): WorkspacePreviewQuality['status'] {
  switch (value) {
    case 'passed':
    case 'failed':
    case 'degraded':
    case 'needs_review':
      return value;
    default:
      return 'unknown';
  }
}

function firstString(values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function qualityFromMetadata(
  artifactMetadata?: Record<string, unknown>,
  resultMetadata?: Record<string, unknown>,
  success?: boolean,
): WorkspacePreviewQuality | undefined {
  const artifactValidation = isRecord(artifactMetadata?.artifactValidation)
    ? artifactMetadata.artifactValidation
    : isRecord(resultMetadata?.artifactValidation)
      ? resultMetadata.artifactValidation
      : undefined;

  if (artifactValidation) {
    const failures = Array.isArray(artifactValidation.failures)
      ? artifactValidation.failures.filter((failure): failure is string => typeof failure === 'string')
      : [];
    if (booleanField(artifactValidation, 'failed')) {
      return {
        status: 'failed',
        summary: failures[0] || 'Artifact validation failed',
        issueCount: Math.max(failures.length, 1),
        blocking: true,
      };
    }
    if (booleanField(artifactValidation, 'passed') === true) {
      return {
        status: 'passed',
        summary: 'Artifact validation passed',
      };
    }
  }

  const qualityReport = isRecord(artifactMetadata?.qualityReport)
    ? artifactMetadata.qualityReport
    : isRecord(resultMetadata?.qualityReport)
      ? resultMetadata.qualityReport
      : undefined;
  if (qualityReport) {
    const status = normalizeQualityStatus(stringField(qualityReport, 'status'));
    if (status !== 'unknown') {
      return {
        status,
        summary: stringField(qualityReport, 'summary') || `Quality report: ${status}`,
      };
    }
  }

  const issueCandidates = [
    ...(Array.isArray(artifactMetadata?.artifactIssues) ? artifactMetadata.artifactIssues : []),
    ...(Array.isArray(resultMetadata?.artifactIssues) ? resultMetadata.artifactIssues : []),
  ].filter(isRecord);

  if (issueCandidates.length > 0) {
    const active = issueCandidates.filter((issue) => isActiveIssueStatus(issue.status));
    const blocking = active.some((issue) => severityRank(issue.severity) >= 4);
    const title = firstString(active.map((issue) => issue.title));
    if (active.length > 0) {
      return {
        status: blocking ? 'failed' : 'needs_review',
        summary: title || `${active.length} active artifact issue(s)`,
        issueCount: active.length,
        blocking,
      };
    }
    return {
      status: 'passed',
      summary: 'Tracked artifact issues are resolved',
      issueCount: issueCandidates.length,
    };
  }

  if (success === false) {
    return {
      status: 'failed',
      summary: 'Tool result failed',
      blocking: true,
    };
  }

  return undefined;
}

function revisionFromArtifact(
  artifact: ReturnType<typeof collectToolArtifactsFromMetadata>[number],
  filePath?: string,
): WorkspacePreviewRevision | undefined {
  const metadata = artifact.metadata;
  const parentId = stringField(metadata, 'parentId') || stringField(metadata, 'parentArtifactId');
  const version = numberField(metadata, 'version');
  if (!artifact.artifactId && !artifact.sha256 && !parentId && version === undefined && !filePath) {
    return undefined;
  }

  return {
    artifactId: artifact.artifactId,
    version,
    parentId,
    parentRef: parentId ? `artifact:${parentId}` : undefined,
    filePath,
    sha256: artifact.sha256,
    sourceTool: artifact.sourceTool,
    changeSummary: stringField(metadata, 'changeSummary') || stringField(metadata, 'editPrompt'),
  };
}

function revisionIdentity(revision: WorkspacePreviewRevision | undefined): string | undefined {
  if (!revision?.artifactId) return undefined;
  return revision.parentId || revision.version !== undefined ? revision.artifactId : undefined;
}

function toolArtifactPreviewItemId(toolCallId: string, artifactId?: string, url?: string): string {
  return `tool-artifact:${toolCallId}:${artifactId || url || 'artifact'}`;
}

function artifactKind(type: string): WorkspacePreviewKind {
  switch (type) {
    case 'spreadsheet':
      return 'spreadsheet';
    case 'document':
      return 'document';
    case 'generative_ui':
      return 'generic_html';
    case 'neo_ui':
      return 'file';
    case 'chart':
      return 'chart';
    case 'mermaid':
      return 'diagram';
    case 'question_form':
      return 'question_form';
    case 'image':
      return 'image';
    case 'audio':
      return 'audio';
    case 'video':
      return 'video';
    default:
      return 'file';
  }
}

function coercePreviewItem(
  value: unknown,
  fallback: Pick<WorkspacePreviewItem, 'id' | 'createdAt' | 'source'>,
): WorkspacePreviewItem | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<WorkspacePreviewItem>;
  if (!raw.kind || !raw.title) return null;
  return {
    id: raw.id || fallback.id,
    kind: raw.kind,
    title: raw.title,
    subtitle: raw.subtitle,
    status: raw.status || 'ready',
    createdAt: raw.createdAt || fallback.createdAt,
    source: raw.source || fallback.source,
    file: raw.file,
    content: raw.content,
    actions: raw.actions,
    priority: raw.priority ?? 50,
    currentTurn: raw.currentTurn,
    designBrief: normalizeDesignBrief(raw.designBrief),
    quality: raw.quality,
    revision: raw.revision,
  };
}

function addItem(
  items: WorkspacePreviewItem[],
  seen: Set<string>,
  item: WorkspacePreviewItem,
  dedupeKey: string,
): void {
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  items.push(item);
}

function collectMessageArtifacts(
  items: WorkspacePreviewItem[],
  seen: Set<string>,
  messages: Message[],
): void {
  for (const message of messages) {
    if (!message.artifacts?.length) continue;
    for (const artifact of message.artifacts) {
      const isQuestionForm = artifact.type === 'question_form';
      addItem(items, seen, {
        id: `artifact:${message.id}:${artifact.id}`,
        kind: artifactKind(artifact.type),
        title: isQuestionForm ? (artifact.title || '设计 brief 收集') : (artifact.title || artifact.type),
        subtitle: isQuestionForm ? '请补齐后提交' : `v${artifact.version}`,
        status: isQuestionForm ? 'draft' : 'ready',
        createdAt: message.timestamp,
        source: {
          kind: 'message',
          label: isQuestionForm ? 'Brief form' : 'Assistant artifact',
          messageId: message.id,
        },
        content: {
          html: artifact.type === 'generative_ui' ? artifact.content : undefined,
          json: ['chart', 'spreadsheet', 'document', 'question_form', 'neo_ui'].includes(artifact.type)
            ? artifact.content
            : undefined,
          text: artifact.type === 'mermaid' ? artifact.content : undefined,
        },
        actions: isQuestionForm ? [] : [
          { kind: 'copy', label: 'Copy' },
        ],
        revision: {
          artifactId: artifact.id,
          version: artifact.version,
          parentId: artifact.parentId,
          parentRef: artifact.parentId ? `artifact:${artifact.parentId}` : undefined,
          changeSummary: artifact.parentId ? `Updated from ${artifact.parentId}` : undefined,
        },
        priority: isQuestionForm ? 85 : 40,
        currentTurn: isQuestionForm ? true : undefined,
      }, `artifact:${artifact.id}`);
    }
  }
}

function collectToolOutputs(
  items: WorkspacePreviewItem[],
  seen: Set<string>,
  messages: Message[],
  workingDirectory?: string | null,
): void {
  for (const message of messages) {
    if (!message.toolCalls?.length) continue;
    for (const toolCall of message.toolCalls) {
      const result = toolCall.result;
      if (!result) continue;
      if (isReadOnlyArtifactTool(toolCall.name)) continue;
      const source = {
        kind: 'tool' as const,
        label: toolCall.name,
        messageId: message.id,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      };
      const fallback = {
        id: `tool-preview:${toolCall.id}`,
        createdAt: message.timestamp,
        source,
      };

      const previewItem = coercePreviewItem(result.metadata?.previewItem, fallback);
      if (previewItem) {
        addItem(items, seen, previewItem, `previewItem:${previewItem.id}`);
      }

      for (const artifact of collectToolArtifactsFromMetadata(result.metadata)) {
        if (artifact.path) {
          const path = resolvePath(artifact.path, workingDirectory);
          if (!path) continue;
          const title = artifact.label || basename(path);
          const quality = qualityFromMetadata(artifact.metadata, result.metadata, result.success);
          const revision = revisionFromArtifact(artifact, path);
          const revisionId = revisionIdentity(revision);
          const itemId = revisionId ? `file:${path}:${revisionId}` : `file:${path}`;
          addItem(items, seen, {
            id: itemId,
            kind: fileKindForPath(path),
            title,
            subtitle: artifact.sourceTool || toolCall.name,
            status: statusFromSuccess(result.success),
            createdAt: message.timestamp,
            source,
            file: {
              path,
              name: artifact.name || basename(path),
              mimeType: artifact.mimeType,
              size: artifact.sizeBytes,
              sha256: artifact.sha256,
            },
            content: artifact.preview ? { summary: artifact.preview } : undefined,
            actions: actionsForFile(path),
            quality,
            revision,
            priority: 35,
          }, revisionId ? `file-revision:${revisionId}` : `file:${path}`);
          continue;
        }

        if (artifact.url) {
          const quality = qualityFromMetadata(artifact.metadata, result.metadata, result.success);
          const revision = revisionFromArtifact(artifact);
          const revisionId = revisionIdentity(revision);
          const itemId = revisionId
            ? `url:${artifact.url}:${revisionId}`
            : toolArtifactPreviewItemId(toolCall.id, artifact.artifactId, artifact.url);
          addItem(items, seen, {
            id: itemId,
            kind: artifact.kind === 'web' ? 'web_snapshot' : 'file',
            title: artifact.label,
            subtitle: artifact.sourceTool || toolCall.name,
            status: statusFromSuccess(result.success),
            createdAt: message.timestamp,
            source,
            content: {
              summary: artifact.preview || artifact.url,
            },
            actions: [
              { kind: 'open', label: 'Open' },
              { kind: 'copy', label: 'Copy' },
            ],
            quality,
            revision,
            priority: 25,
          }, revisionId ? `url-revision:${revisionId}` : `url:${artifact.url}`);
        }
      }

      const paths = new Set<string>();
      if (result.outputPath) paths.add(result.outputPath);
      for (const key of FILE_METADATA_KEYS) {
        const value = result.metadata?.[key];
        if (typeof value === 'string' && value.trim()) {
          paths.add(value.trim());
        }
      }

      for (const rawPath of paths) {
        const path = resolvePath(rawPath, workingDirectory);
        if (!path) continue;
        const title = basename(path);
        addItem(items, seen, {
          id: `file:${path}`,
          kind: fileKindForPath(path),
          title,
          subtitle: toolCall.name,
          status: statusFromSuccess(result.success),
          createdAt: message.timestamp,
          source,
          file: {
            path,
            name: title,
            size: typeof result.metadata?.fileSize === 'number' ? result.metadata.fileSize : undefined,
          },
          actions: actionsForFile(path),
          priority: 30,
        }, `file:${path}`);
      }

    }
  }
}

function collectPermissionPreview(
  items: WorkspacePreviewItem[],
  seen: Set<string>,
  request?: PermissionRequest | null,
): void {
  const preview = request?.details.preview;
  if (!request || !preview) return;
  const filePath = request.details.filePath || request.details.path;
  const kind: WorkspacePreviewKind = preview.type === 'diff'
    ? 'diff'
    : preview.type === 'command'
      ? 'terminal'
      : 'file';

  addItem(items, seen, {
    id: `permission:${request.id}`,
    kind,
    title: preview.summary || request.tool,
    subtitle: request.tool,
    status: 'draft',
    createdAt: request.timestamp,
    source: {
      kind: 'permission',
      label: request.tool,
    },
    file: filePath ? { path: filePath, name: basename(filePath) } : undefined,
    content: {
      summary: preview.summary,
      diff: preview.diff,
      before: preview.before,
      after: preview.after,
      text: preview.type !== 'diff' ? preview.diff || preview.summary : undefined,
    },
    actions: [
      { kind: 'confirm', label: 'Review' },
    ],
    priority: 90,
    currentTurn: true,
  }, `permission:${request.id}`);
}

function collectCurrentTurnArtifacts(
  items: WorkspacePreviewItem[],
  seen: Set<string>,
  currentTurnArtifacts: BuildWorkspacePreviewItemsInput['currentTurnArtifacts'],
  workingDirectory?: string | null,
): void {
  if (!currentTurnArtifacts) return;
  for (const artifact of currentTurnArtifacts.artifactOwnership) {
    if (artifact.path) {
      const path = resolvePath(artifact.path, workingDirectory);
      const title = basename(path);
      addItem(items, seen, {
        id: `turn-file:${currentTurnArtifacts.turnNumber}:${path}`,
        kind: fileKindForPath(path),
        title,
        subtitle: artifact.ownerLabel,
        status: 'ready',
        createdAt: Date.now(),
        source: {
          kind: artifact.ownerKind === 'tool' ? 'tool' : 'message',
          label: artifact.ownerLabel,
          turnNumber: currentTurnArtifacts.turnNumber,
        },
        file: { path, name: title },
        actions: actionsForFile(path),
        priority: 80,
        currentTurn: true,
      }, `file:${path}`);
      continue;
    }

    addItem(items, seen, {
      id: `turn-artifact:${currentTurnArtifacts.turnNumber}:${artifact.sourceNodeId || artifact.label}`,
      kind: artifact.kind === 'link' ? 'file' : 'trace',
      title: artifact.label,
      subtitle: artifact.ownerLabel,
      status: 'ready',
      createdAt: Date.now(),
      source: {
        kind: artifact.ownerKind === 'tool' ? 'tool' : 'message',
        label: artifact.ownerLabel,
        turnNumber: currentTurnArtifacts.turnNumber,
      },
      priority: 70,
      currentTurn: true,
    }, `turn-artifact:${currentTurnArtifacts.turnNumber}:${artifact.label}`);
  }
}

export function buildWorkspacePreviewItems(input: BuildWorkspacePreviewItemsInput): WorkspacePreviewItem[] {
  const items: WorkspacePreviewItem[] = [];
  const seen = new Set<string>();
  const messages = input.messages.slice(-60);

  collectPermissionPreview(items, seen, input.pendingPermissionRequest);
  collectCurrentTurnArtifacts(items, seen, input.currentTurnArtifacts, input.workingDirectory);
  collectToolOutputs(items, seen, messages, input.workingDirectory);
  collectMessageArtifacts(items, seen, messages);

  return items
    .sort((left, right) => {
      const byPriority = (right.priority ?? 0) - (left.priority ?? 0);
      if (byPriority !== 0) return byPriority;
      return right.createdAt - left.createdAt;
    })
    .slice(0, input.limit ?? 40);
}
