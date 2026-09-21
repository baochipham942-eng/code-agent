import React from 'react';
import type { LibraryEvidenceProjection } from '@shared/contract/library';
import { useI18n } from '../../hooks/useI18n';
import { Modal } from '../primitives/Modal';

interface LibraryEvidenceDrawerProps {
  projection: LibraryEvidenceProjection | null;
  loading?: boolean;
  onClose: () => void;
}

export function LibraryEvidenceDrawer({ projection, loading = false, onClose }: LibraryEvidenceDrawerProps) {
  const { t } = useI18n();
  const isOpen = Boolean(projection) || Boolean(loading);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t.library.evidenceTitle}
      size="xl"
      portal
      header={
        <div className="min-w-0">
          <div className="text-sm font-medium text-zinc-200">{t.library.evidenceTitle}</div>
          <div className="truncate text-[11px] text-zinc-500">
            {projection?.item?.title ?? projection?.query.source}
          </div>
        </div>
      }
    >
      {loading ? (
        <div className="p-1 text-sm text-zinc-500">{t.library.evidenceLoading}</div>
      ) : projection?.hit && projection.fragment ? (
        <div className="min-h-0">
          <div className="mb-2 text-[11px] text-zinc-500">
            {t.library.evidenceLines
              .replace('{start}', String(projection.fragment.startLine))
              .replace('{end}', String(projection.fragment.endLine))
              .replace('{total}', String(projection.fragment.totalLines))}
          </div>
          <pre className="whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-900/70 p-3 text-xs leading-relaxed text-zinc-300">{projection.fragment.text}</pre>
        </div>
      ) : (
        <div className="text-sm text-zinc-400">
          <div className="font-medium text-zinc-300">{t.library.evidenceNoHit}</div>
          {projection?.reason && <div className="mt-2 text-xs text-zinc-500">{t.library.evidenceReason}: {projection.reason}</div>}
        </div>
      )}
    </Modal>
  );
}
