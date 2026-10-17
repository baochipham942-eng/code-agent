import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { CreateCronJobInput } from '../../../../services/cronClient';

export interface ScheduleRestatement {
  what: string;
  notifyWhen: string;
}

export interface PendingScheduleDraft {
  input: CreateCronJobInput;
  restatement?: ScheduleRestatement;
  description: string;
  handoffPrompt?: string;
  sourceSessionId: string | null;
  /**
   * event 草案（N-CRON-EVENT-CREATE-CHAT）：用户原话里的群名提示。
   * 只供确认卡在选完账号后按群名预选群，不进 createJob 载荷。
   */
  eventGroupName?: string;
}

export interface ScheduleDraftController {
  pendingScheduleDraft: PendingScheduleDraft | null;
  storePendingScheduleDraft: (draft: PendingScheduleDraft) => boolean;
  discardPendingScheduleDraft: () => void;
  setCreatingSchedule: Dispatch<SetStateAction<boolean>>;
}

export function useScheduleDraft(currentSessionId: string | null) {
  const [scheduleComposerOpen, setScheduleComposerOpen] = useState(false);
  const [creatingSchedule, setCreatingSchedule] = useState(false);
  const [pendingScheduleDraft, setPendingScheduleDraft] = useState<PendingScheduleDraft | null>(null);
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;

  useEffect(() => {
    setPendingScheduleDraft(null);
    setScheduleComposerOpen(false);
    setCreatingSchedule(false);
  }, [currentSessionId]);

  const storePendingScheduleDraft = useCallback((draft: PendingScheduleDraft): boolean => {
    if (draft.sourceSessionId !== currentSessionIdRef.current) return false;
    setPendingScheduleDraft(draft);
    return true;
  }, []);

  const discardPendingScheduleDraft = useCallback(() => {
    setPendingScheduleDraft(null);
    setCreatingSchedule(false);
  }, []);

  return {
    scheduleComposerOpen,
    setScheduleComposerOpen,
    creatingSchedule,
    setCreatingSchedule,
    pendingScheduleDraft,
    storePendingScheduleDraft,
    discardPendingScheduleDraft,
  };
}
