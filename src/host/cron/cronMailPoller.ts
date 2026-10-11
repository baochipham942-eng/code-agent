// ============================================================================
// CronMailPoller — 'event' 调度的 mail 连接器轮询源（N-TRIGGER-CONNECTOR-MAIL）
// ----------------------------------------------------------------------------
// 从 cronEventTrigger 拆出：按 pollIntervalSec 轮询本地 Mail 账号（macOS Mail，
// 经 connector registry 的 mail 连接器）的未读邮件，把新邮件喂回 CronEventTrigger
// 的同一条 合批/限频/去重/单 run 上限 链路。仍然只进不出：不开端口、不挂 HTTP
// endpoint。语义要点：
//   起播种子 —— 启动后首个「成功」轮询只登记现有未读、不触发（存量未读不洪水）；
//   失败不吞 —— 轮询失败只告警（原因可区分：缺连接器 / 未就绪 / 读取失败），
//     不把任何邮件记为已见、不当「没有新邮件」，下一趟照常把期间到达的送进来；
//   幂等去重 —— key = mail 订阅 id + account|mailbox|id，共用 BoundedDedupeSet。
// ============================================================================

import { createHash } from 'crypto';
import type { CronJobDefinition, EventConnectorMailScheduleConfig } from '../../shared/contract/cron';
import { CRON_EVENT_TRIGGER } from '../../shared/constants';
import { BoundedDedupeSet } from '../channels/inboundDedupe';
import { getConnectorRegistry } from '../connectors/registry';

/** mail 源单次轮询拿到的邮件摘要（mail connector list_messages 的 data 项形状）。 */
interface CronMailPollMessage {
  id: number;
  subject: string;
  sender: string;
  receivedAtMs: number | null;
  read: boolean;
}

/** mail 轮询失败的可区分原因（降级必须留可区分的痕：缺件 ≠ 未就绪 ≠ 读取失败）。 */
type CronMailPollFailureCause = 'connector-missing' | 'connector-not-ready' | 'read-error';

/** mail 轮询错误：cause 携带可区分失败原因（本模块与测试经公开入口观测日志分类）。 */
class CronMailPollError extends Error {
  constructor(
    readonly cause: CronMailPollFailureCause,
    message: string,
  ) {
    super(message);
    this.name = 'CronMailPollError';
  }
}

/** mail 源读取 seam：生产缺省走 connector registry，测试注入假实现（无真实 Mail）。 */
export interface CronMailReader {
  /** 列出 mailbox 内最新邮件摘要（含已读/未读标记）；失败抛 CronMailPollError。 */
  listMessages(account: string, mailbox: string, limit: number): Promise<readonly CronMailPollMessage[]>;
  /** 读取单封邮件正文（截断由调用方负责）；失败抛错，调用方降级为无正文。 */
  readMessage(account: string, mailbox: string, messageId: number): Promise<string>;
}

/** mail 事件附加字段：account/mailbox/数值 id 供补取正文，主题与发件人同样不可信。 */
export interface MailEventFields {
  account: string;
  mailbox: string;
  /** mail connector 的数值 id（read_message 用）；messageId 是 account|mailbox|id 组合键。 */
  messageId: number;
  subject: string;
  /** 进批后经 read_message 补取的正文（已截断）；取失败留空（降级为主题+发件人）。 */
  body?: string;
}

/** mail 轮询喂回合批链路的事件形状（CronEventTrigger 补齐通道侧字段后入队）。 */
interface MailEventRecord {
  /** account|mailbox|id 组合键（去重与 eventIds 溯源共用）。 */
  messageId: string;
  senderName: string;
  /** 主题（正文进批后才按需补取）。 */
  text: string;
  timestamp: number;
  mail: MailEventFields;
}

/** 错误转可读文本（cronEventTrigger 的 mail 批正文补取降级日志共用）。 */
export function mailErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 生产缺省 mail 读取器：registry 的 mail 连接器（AppleScript，仅 macOS）。
 * 未注册（设置里没启用）= connector-missing；已注册但探测未通过 = connector-not-ready
 * （重启后 readiness 回 unchecked，这里自动补探测，不逼用户每次手动点授权）；
 * list_messages 抛错 = read-error。
 */
export function createDefaultMailReader(): CronMailReader {
  const mailConnector = () => {
    const connector = getConnectorRegistry().get('mail');
    if (!connector) {
      throw new CronMailPollError(
        'connector-missing',
        'Mail connector is not registered (enable the Mail connector in settings first).',
      );
    }
    return connector;
  };
  return {
    async listMessages(account, mailbox, limit) {
      const connector = mailConnector();
      const readiness = connector.getCachedStatus?.().readiness;
      if (readiness !== 'ready') {
        try {
          await connector.execute('probe_access', {});
        } catch (error) {
          throw new CronMailPollError(
            'connector-not-ready',
            `Mail connector is not ready (${readiness ?? 'unknown'}): ${mailErrorMessage(error)}`,
          );
        }
      }
      try {
        const result = await connector.execute('list_messages', { account, mailbox, limit });
        return Array.isArray(result.data) ? (result.data as CronMailPollMessage[]) : [];
      } catch (error) {
        throw new CronMailPollError('read-error', `Mail list_messages failed: ${mailErrorMessage(error)}`);
      }
    },
    async readMessage(account, mailbox, messageId) {
      const connector = mailConnector();
      const result = await connector.execute('read_message', { account, mailbox, message_id: messageId });
      const data = result.data as { content?: unknown } | null;
      return typeof data?.content === 'string' ? data.content : '';
    },
  };
}

/** mail 源订阅 id：sha256(jobId|account|mailbox|eventName|mail)，与通道订阅天然不撞。 */
function mailSubscriptionId(jobId: string, schedule: EventConnectorMailScheduleConfig): string {
  const mailbox = schedule.mailbox ?? CRON_EVENT_TRIGGER.DEFAULT_MAILBOX;
  return createHash('sha256')
    .update(`${jobId}|${schedule.accountId}|${mailbox}|${schedule.eventName}|mail`)
    .digest('hex');
}

/** mail 去重/溯源键：account|mailbox|id（id 是 per-mailbox 数值，必须带上定位两元组）。 */
function mailEventKey(account: string, mailbox: string, messageId: number): string {
  return `${account}|${mailbox}|${messageId}`;
}

/** 取定义里的 mail 源调度；不是 connector:mail + message 的事件源返回 undefined。 */
function mailScheduleOf(definition: CronJobDefinition): EventConnectorMailScheduleConfig | undefined {
  const schedule = definition.schedule;
  if (schedule?.type !== 'event' || schedule.source !== 'connector') return undefined;
  if (schedule.connector !== 'mail' || schedule.eventName !== 'message') return undefined;
  return schedule;
}

/** mail 轮询间隔（毫秒）：缺省 DEFAULT_POLL_INTERVAL_SEC，下限 MIN_POLL_INTERVAL_SEC 不放低。 */
function scheduleMailPollIntervalMs(schedule: EventConnectorMailScheduleConfig): number {
  const seconds = Math.max(
    schedule.pollIntervalSec ?? CRON_EVENT_TRIGGER.DEFAULT_POLL_INTERVAL_SEC,
    CRON_EVENT_TRIGGER.MIN_POLL_INTERVAL_SEC,
  );
  return seconds * 1000;
}

/** mail 源轮询状态（per job；失败轮询不推进 seeded，也不把任何邮件记为已见）。 */
interface MailPollState {
  /** 下次轮询时刻（ms epoch）；到点由轮询 tick 驱动。 */
  nextPollAt: number;
  /** 起播种子是否完成：启动后首个「成功」轮询只登记现有未读、不触发（防存量未读洪水）。 */
  seeded: boolean;
}

export interface CronMailPollerOptions {
  host: { getJobDefinitions(): CronJobDefinition[] };
  /** 与通道事件共用的有界去重集（mail key 已含独立订阅 id，不与通道 key 相撞）。 */
  dedupe: BoundedDedupeSet;
  /** 新邮件入队回调：进 CronEventTrigger 的合批/限频链路（与通道事件同一条路）。 */
  enqueue: (definition: CronJobDefinition, record: MailEventRecord) => void;
  mailReader: CronMailReader;
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => { clear(): void };
}

/**
 * mail 轮询器：固定粒度 tick 扫描到期任务（任务增删改不需要通知——下一个 tick
 * 重读任务表自然生效）。tick 单链：上一趟扫描结束才挂下一个，轮询卡死不堆并发。
 */
export class CronMailPoller {
  private readonly host: CronMailPollerOptions['host'];
  private readonly dedupe: BoundedDedupeSet;
  private readonly enqueue: CronMailPollerOptions['enqueue'];
  private readonly mailReader: CronMailReader;
  private readonly now: () => number;
  private readonly setTimer: CronMailPollerOptions['setTimer'];
  private readonly states = new Map<string, MailPollState>();
  private pollTimer?: { clear(): void };

  constructor(options: CronMailPollerOptions) {
    this.host = options.host;
    this.dedupe = options.dedupe;
    this.enqueue = options.enqueue;
    this.mailReader = options.mailReader;
    this.now = options.now;
    this.setTimer = options.setTimer;
  }

  start(): void {
    this.scheduleTick();
  }

  dispose(): void {
    this.pollTimer?.clear();
    this.pollTimer = undefined;
    this.states.clear();
  }

  private scheduleTick(): void {
    if (this.pollTimer !== undefined) return;
    this.pollTimer = this.setTimer(() => {
      this.pollTimer = undefined;
      void this.pollDueJobs();
    }, CRON_EVENT_TRIGGER.MAIL_POLL_TICK_MS);
  }

  private async pollDueJobs(): Promise<void> {
    try {
      const now = this.now();
      const due = this.host.getJobDefinitions().filter((definition) => {
        if (!definition.enabled) return false;
        if (mailScheduleOf(definition) === undefined) return false;
        const state = this.states.get(definition.id);
        return state === undefined || now >= state.nextPollAt;
      });
      for (const definition of due) {
        await this.pollJob(definition);
      }
    } finally {
      // 无论本轮成败，链不断（失败任务的下一次轮询照常到点重试）。
      this.scheduleTick();
    }
  }

  /**
   * 轮询单个 mail 任务。失败只告警（带可区分原因）并按间隔重试：不标记任何邮件
   * 已见、不当「没有新邮件」，下一趟轮询照常把期间到达的邮件送进来。
   */
  private async pollJob(definition: CronJobDefinition): Promise<void> {
    const schedule = mailScheduleOf(definition);
    if (!schedule) return;
    const state = this.stateFor(definition.id);
    const mailbox = schedule.mailbox ?? CRON_EVENT_TRIGGER.DEFAULT_MAILBOX;
    // 先排下一趟：成败都按节奏走（失败按原间隔重试，不空转也不把失败当空轮询）。
    state.nextPollAt = this.now() + scheduleMailPollIntervalMs(schedule);

    let messages: readonly CronMailPollMessage[];
    try {
      messages = await this.mailReader.listMessages(schedule.accountId, mailbox, CRON_EVENT_TRIGGER.MAIL_POLL_LIST_LIMIT);
    } catch (error) {
      const cause = error instanceof CronMailPollError ? error.cause : 'read-error';
      console.error(`[CronMailPoller] Mail poll failed for job ${definition.id} (cause: ${cause}): ${mailErrorMessage(error)}`);
      return;
    }
    const unread = messages.filter((message) => message.read === false);
    const subscriptionId = mailSubscriptionId(definition.id, schedule);
    // 起播种子：启动后首个成功轮询只登记现有未读、不触发（存量未读不洪水）。
    // 失败轮询不推进 seeded——基线以最终成功的那一趟为准。
    if (!state.seeded) {
      state.seeded = true;
      for (const message of unread) {
        this.dedupe.markSeen(`${subscriptionId}:${mailEventKey(schedule.accountId, mailbox, message.id)}`);
      }
      return;
    }
    for (const message of unread) {
      const eventKey = mailEventKey(schedule.accountId, mailbox, message.id);
      if (!this.dedupe.markSeen(`${subscriptionId}:${eventKey}`)) continue;
      this.enqueue(definition, {
        messageId: eventKey,
        senderName: message.sender,
        text: message.subject,
        timestamp: message.receivedAtMs ?? this.now(),
        mail: { account: schedule.accountId, mailbox, messageId: message.id, subject: message.subject },
      });
    }
  }

  private stateFor(jobId: string): MailPollState {
    let state = this.states.get(jobId);
    if (!state) {
      state = { nextPollAt: 0, seeded: false };
      this.states.set(jobId, state);
    }
    return state;
  }
}
