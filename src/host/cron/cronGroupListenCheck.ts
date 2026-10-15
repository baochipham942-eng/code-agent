import type { ChannelMessage } from '../../shared/contract/channel';
import type { CronGroupListenCheck, CronJobDefinition } from '../../shared/contract/cron';
import { CRON_EVENT_TRIGGER } from '../../shared/constants/cronEventTrigger';

interface Check extends CronGroupListenCheck {
  startedAt: number;
  deadlineAt: number;
  accountId: string;
  chatId: string;
}

/** Receipt-only observation. It never sends messages or changes task execution. */
export class CronGroupListenChecks {
  private readonly checks = new Map<string, Check>();

  constructor(
    private readonly getJobs: () => CronJobDefinition[],
    private readonly now: () => number,
  ) {}

  get(jobId: string, start = false): CronGroupListenCheck | null {
    const job = this.getJobs().find((item) => item.id === jobId);
    const schedule = job?.schedule;
    if (!job?.enabled || job.runsOn !== 'local' || schedule?.type !== 'event'
      || schedule.source !== 'channel' || schedule.eventName !== 'message' || !schedule.chatId) {
      this.forget(jobId);
      return null;
    }
    let check = this.checks.get(jobId);
    if (check && (check.accountId !== schedule.accountId || check.chatId !== schedule.chatId)) {
      this.forget(jobId);
      check = undefined;
    }
    if (start) {
      const startedAt = this.now();
      check = {
        accountId: schedule.accountId,
        chatId: schedule.chatId,
        status: 'waiting',
        startedAt,
        deadlineAt: startedAt + CRON_EVENT_TRIGGER.GROUP_LISTEN_CHECK_MINUTES * 60_000,
      };
      this.checks.set(jobId, check);
    }
    if (!check) return { status: 'idle' };
    if (check.status === 'waiting' && this.now() >= check.deadlineAt) {
      check.status = 'timed_out';
    }
    return { status: check.status, startedAt: check.startedAt, deadlineAt: check.deadlineAt };
  }

  observe(accountId: string, message: ChannelMessage): void {
    if (message.context?.chatType !== 'group' || message.sender?.isBot) return;
    for (const [jobId, check] of this.checks) {
      if (this.get(jobId)?.status !== 'waiting') continue;
      if (check.accountId !== accountId || check.chatId !== message.context.chatId) continue;
      // Do not let a delayed delivery from before this attempt certify the check.
      if (!Number.isFinite(message.timestamp) || message.timestamp < check.startedAt) continue;
      check.status = 'connected';
    }
  }

  forget(jobId: string): void {
    this.checks.delete(jobId);
  }

  clear(): void {
    this.checks.clear();
  }
}
