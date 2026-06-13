import type { WorkspacePreviewItem } from '@shared/contract';

export interface ComparableWorkspaceContent {
  label: string;
  value: string;
}

export interface WorkspaceRevisionComparison {
  previous: WorkspacePreviewItem;
  current: WorkspacePreviewItem;
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
  fileName: string;
}

function revisionArtifactId(item: WorkspacePreviewItem): string | undefined {
  return item.revision?.artifactId?.trim() || undefined;
}

function revisionParentId(item: WorkspacePreviewItem): string | undefined {
  return item.revision?.parentId?.trim() || undefined;
}

function revisionSortValue(item: WorkspacePreviewItem): number {
  return item.revision?.version ?? item.createdAt;
}

function tryFormatJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function getComparableWorkspaceContent(item: WorkspacePreviewItem): ComparableWorkspaceContent | null {
  const content = item.content;
  if (!content) return null;

  if (content.json) {
    return { label: 'JSON', value: tryFormatJson(content.json) };
  }
  if (content.html) {
    return { label: 'HTML', value: content.html };
  }
  if (content.text) {
    return { label: 'Text', value: content.text };
  }
  if (content.diff) {
    return { label: 'Diff', value: content.diff };
  }
  if (content.summary) {
    return { label: 'Summary', value: content.summary };
  }

  return null;
}

export function buildWorkspaceRevisionHistory(
  items: WorkspacePreviewItem[],
  selected: WorkspacePreviewItem | null | undefined,
): WorkspacePreviewItem[] {
  if (!selected) return [];

  const selectedArtifactId = revisionArtifactId(selected);
  if (!selectedArtifactId) {
    const filePath = selected.file?.path;
    return filePath ? items.filter((item) => item.file?.path === filePath) : [];
  }

  const byArtifactId = new Map<string, WorkspacePreviewItem>();
  for (const item of items) {
    const artifactId = revisionArtifactId(item);
    if (artifactId) {
      byArtifactId.set(artifactId, item);
    }
  }

  const related = new Set<string>();
  let cursor: string | undefined = selectedArtifactId;
  while (cursor && !related.has(cursor)) {
    related.add(cursor);
    cursor = revisionParentId(byArtifactId.get(cursor) || selected);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      const artifactId = revisionArtifactId(item);
      const parentId = revisionParentId(item);
      if (!artifactId || related.has(artifactId) || !parentId) continue;
      if (related.has(parentId)) {
        related.add(artifactId);
        changed = true;
      }
    }
  }

  return items
    .filter((item) => {
      const artifactId = revisionArtifactId(item);
      return artifactId ? related.has(artifactId) : false;
    })
    .sort((left, right) => {
      const versionDelta = revisionSortValue(left) - revisionSortValue(right);
      if (versionDelta !== 0) return versionDelta;
      return left.createdAt - right.createdAt;
    });
}

export function buildWorkspaceRevisionComparison(
  items: WorkspacePreviewItem[],
  selected: WorkspacePreviewItem | null | undefined,
): WorkspaceRevisionComparison | null {
  if (!selected) return null;
  const history = buildWorkspaceRevisionHistory(items, selected);
  if (history.length < 2) return null;

  const parentId = revisionParentId(selected);
  const previous = parentId
    ? history.find((item) => revisionArtifactId(item) === parentId)
    : history[Math.max(0, history.findIndex((item) => item.id === selected.id) - 1)];
  if (!previous || previous.id === selected.id) return null;

  const before = getComparableWorkspaceContent(previous);
  const after = getComparableWorkspaceContent(selected);
  if (!before || !after) return null;

  return {
    previous,
    current: selected,
    before: before.value,
    after: after.value,
    beforeLabel: before.label,
    afterLabel: after.label,
    fileName: selected.file?.name || selected.title,
  };
}
