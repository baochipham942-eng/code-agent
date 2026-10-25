import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { CreateCronJobInput } from '../../../../services/cronClient';
import type { EventScheduleDisplayNames } from '../../cron/types';

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
  /**
   * event 草案的当前绑定显示名（rework r1）：卡内选账号/群时由选择回调带上来的
   * 通道目录名，供「监听哪个群」行摘要陈述实际绑定。与 eventGroupName 同为草案级
   * 展示快照，不进 createJob 载荷。
   */
  eventBindingNames?: EventScheduleDisplayNames;
  /**
   * 草案身份（rework r1）：入库时由 useScheduleDraft 盖章，卡内编辑写回原样携带。
   * 同一会话旧卡未确认时再次 /schedule 会整体替换草案（挂载点没有 key、卡片不重挂），
   * 确认卡据此重置挂载期初始化的本地编辑态，避免上一份草案的账号/群/预算残留进新卡。
   */
  draftId?: number;
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

  // 草案身份计数器：只有「新草案入库」会盖章（新草案从不带 draftId），
  // 卡内编辑写回经扩展符携带原 id 进来，不换身份、不触发确认卡重置。
  const draftSeqRef = useRef(0);
  const storePendingScheduleDraft = useCallback((draft: PendingScheduleDraft): boolean => {
    if (draft.sourceSessionId !== currentSessionIdRef.current) return false;
    setPendingScheduleDraft(draft.draftId !== undefined ? draft : { ...draft, draftId: ++draftSeqRef.current });
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
