import React, { useEffect, useState } from 'react';
import type { CronGroupListenCheck as Check } from '@shared/contract/cron';
import { CRON_EVENT_TRIGGER } from '@shared/constants/cronEventTrigger';
import { useI18n } from '../../../hooks/useI18n';
import { cronClient } from '../../../services/cronClient';
import { Button } from '../../primitives/Button';

export function CronGroupListenCheck({ jobId }: { jobId: string }) {
  const { t } = useI18n();
  const copy = t.cronCenter.groupListenCheck;
  const [attempt, setAttempt] = useState(0);
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setBusy(true);
    setFailed(false);
    const read = async (start: boolean) => {
      try {
        const next = await (start
          ? cronClient.startGroupListenCheck(jobId)
          : cronClient.getGroupListenCheck(jobId));
        if (!active) return;
        setCheck(next);
        setBusy(false);
        if (next?.status === 'waiting') {
          timer = setTimeout(() => void read(false), CRON_EVENT_TRIGGER.GROUP_LISTEN_CHECK_POLL_MS);
        }
      } catch {
        if (!active) return;
        setCheck(null);
        setBusy(false);
        setFailed(true);
      }
    };
    void read(attempt > 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [jobId, attempt]);

  if (!check && !failed) return null;
  return (
    <section className="mt-4 space-y-2 rounded-lg border border-zinc-700 p-3" aria-label={copy.title}>
      <p className="text-sm text-zinc-300">{copy.title}</p>
      <p className="text-xs text-zinc-400">{copy.instructions.replace('{minutes}', String(CRON_EVENT_TRIGGER.GROUP_LISTEN_CHECK_MINUTES))}</p>
      <Button size="sm" variant="secondary" disabled={busy || check?.status === 'waiting'} onClick={() => setAttempt((value) => value + 1)}>
        {copy.start}
      </Button>
      <div role="status" className="text-sm text-zinc-300">
        {failed ? copy.error : check?.status === 'waiting' ? copy.waiting
          : check?.status === 'connected' ? copy.connected
            : check?.status === 'timed_out' ? copy.timeout : null}
      </div>
      {check?.status === 'timed_out' && <p className="text-xs text-badge-warning">{copy.permissionHint}</p>}
    </section>
  );
}
