import { useCallback, useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import type { ArtifactFollowEntry } from '../stores/artifactFollowStore';

export interface PreviewFileMetadata {
  path: string;
  size: number;
  modifiedAt: number;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function usePreviewFileMetadata(filePath: string | null): {
  fileMetadata: PreviewFileMetadata | null;
  refreshFileMetadata: (path: string) => Promise<void>;
} {
  const [fileMetadata, setFileMetadata] = useState<PreviewFileMetadata | null>(null);
  useEffect(() => setFileMetadata(null), [filePath]);
  const refreshFileMetadata = useCallback(async (path: string) => {
    try {
      setFileMetadata(await ipcService.invokeDomain<PreviewFileMetadata>(
        IPC_DOMAINS.WORKSPACE,
        'getFileMetadata',
        { filePath: path },
      ));
    } catch {
      // Metadata is supplementary; the preview's content error remains the visible failure.
    }
  }, []);
  return { fileMetadata, refreshFileMetadata };
}

export function artifactCompletionMeta(input: {
  entry?: ArtifactFollowEntry;
  metadata: PreviewFileMetadata | null;
  filePath: string;
  language: 'zh' | 'en';
  label: string;
}): string | null {
  if (input.entry?.phase !== 'complete') return null;
  const time = new Date(input.entry.completedAt ?? input.metadata?.modifiedAt ?? Date.now())
    .toLocaleTimeString(input.language === 'en' ? 'en-US' : 'zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
  const size = input.metadata?.path === input.filePath ? formatFileSize(input.metadata.size) : null;
  return [input.label, time, size].filter(Boolean).join(' · ');
}
