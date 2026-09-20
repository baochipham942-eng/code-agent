import React from 'react';
import { X } from 'lucide-react';
import type { LibraryEvidenceProjection } from '@shared/contract/library';
import { useI18n } from '../../hooks/useI18n';

interface LibraryEvidenceDrawerProps {
  projection: LibraryEvidenceProjection | null;
  loading?: boolean;
  onClose: () => void;
}

export function LibraryEvidenceDrawer({ projection, loading = false, onClose }: LibraryEvidenceDrawerProps) {
  const { t } = useI18n();
  if (!projection && !loading) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" role="dialog" aria-modal="true" aria-label={t.library.evidenceTitle}>
      <aside className="flex h-full w-full max-w-xl flex-col border-l border-zinc-700 bg-zinc-950 shadow-2xl">
        <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-zinc-200">{t.library.evidenceTitle}</div>
            <div className="truncate text-[11px] text-zinc-500">{projection?.item?.title ?? projection?.query.source}</div>
          </div>
          <button type="button" onClick={onClose} aria-label={t.library.evidenceClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
            <X className="h-4 w-4" />
          </button>
        </header>
        {loading ? (
          <div className="p-4 text-sm text-zinc-500">{t.library.evidenceLoading}</div>
        ) : projection?.hit && projection.fragment ? (
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <div className="mb-2 text-[11px] text-zinc-500">
              {t.library.evidenceLines
                .replace('{start}', String(projection.fragment.startLine))
                .replace('{end}', String(projection.fragment.endLine))
                .replace('{total}', String(projection.fragment.totalLines))}
            </div>
            <pre className="whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-900/70 p-3 text-xs leading-relaxed text-zinc-300">{projection.fragment.text}</pre>
          </div>
        ) : (
          <div className="p-4 text-sm text-zinc-400">
            <div className="font-medium text-zinc-300">{t.library.evidenceNoHit}</div>
            {projection?.reason && <div className="mt-2 text-xs text-zinc-500">{t.library.evidenceReason}: {projection.reason}</div>}
          </div>
        )}
      </aside>
    </div>
  );
}
