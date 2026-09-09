import React, { useEffect, useRef, useState } from 'react';
import type { DeliverablePublishInfo, PublishedDeliverableVersion } from '@shared/contract';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import { useI18n } from '../hooks/useI18n';
import { toast } from '../hooks/useToast';
import { Button } from './primitives/Button';
import { Modal } from './primitives/Modal';
import { Input } from './primitives/Input';

/** The artifact page owns publishing; opening a file never publishes it. */
export const PublishVersionButton: React.FC<{
  filePath: string;
  title: string;
  info: DeliverablePublishInfo;
  disabled?: boolean;
  onPublished: (info: DeliverablePublishInfo) => void;
}> = ({ filePath, title, info, disabled, onPublished }) => {
  const { t } = useI18n();
  const labels = t.deliverable;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [publishing, setPublishing] = useState(false);
  const nextVersion = (info.publishedVersions[0]?.version ?? 0) + 1;
  const confirm = async () => {
    if (publishing || disabled) return;
    setPublishing(true);
    try {
      const result = await ipcService.invokeDomain<DeliverablePublishInfo & { publishedVersion: PublishedDeliverableVersion }>(
        IPC_DOMAINS.WORKSPACE, 'publishVersion', { filePath, note },
      );
      if (!mounted.current) return;
      onPublished(result);
      setOpen(false);
      toast.success(labels.publishSuccess.replace('{version}', String(result.publishedVersion.version)));
    } catch (error) {
      toast.error(`${labels.publishFailed}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPublishing(false);
    }
  };
  return <>
    <Button size="sm" variant="secondary" disabled={disabled}
      onClick={() => { setNote(''); setOpen(true); }}>{labels.publishVersion}</Button>
    <Modal isOpen={open} onClose={() => { if (!publishing) setOpen(false); }}
      title={labels.publishConfirmTitle} size="sm" portal footer={<>
        <Button variant="ghost" size="sm" disabled={publishing} onClick={() => setOpen(false)}>{t.common.cancel}</Button>
        <Button variant="primary" size="sm" loading={publishing} disabled={disabled} onClick={() => void confirm()}>{labels.publish}</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-xs leading-5 text-zinc-400">{labels.publishConfirmDescription.replace('{title}', title).replace('{version}', String(nextVersion))}</p>
        <label className="block space-y-1.5 text-xs text-zinc-300">
          <span>{labels.publishNote}</span>
          <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder={labels.publishNotePlaceholder} maxLength={160} autoFocus />
        </label>
      </div>
    </Modal>
  </>;
};
