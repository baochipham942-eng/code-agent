// ============================================================================
// VoiceNarrationQueue —— 回流播报的排队/节流状态机（发言人协议 §2.2 + 方案 §2）
//
// 从 voiceSessionService 抽出来：它是个自洽状态机，只吃 narration 子状态 + 上游注入通道，
// 对外只有 4 个入口（入队/用户开口/轮末放行/注入被拒）。抽出来之后 voiceSessionService
// 回到 god-file 门以下，这条队列的规则也终于有了自己的家。
// ============================================================================

import {
  VOICE_MILESTONE_FIRST_DELAY_MS,
  VOICE_MILESTONE_MAX_PER_WORK_ITEM,
  VOICE_MILESTONE_MIN_INTERVAL_MS,
  VOICE_MILESTONE_STALE_MS,
} from '../../../shared/constants/voice';
import type { VoiceTransportHandle, VoiceWorkNarration } from '../../../shared/contract/voice';
import { createLogger } from '../infra/logger';

const logger = createLogger('VoiceSession');

interface PendingNarration {
  narration: VoiceWorkNarration;
  suppressedTurns: number;
  rejectionCount: number;
  enqueuedAt: number;
}

/** 终态播报只属于这通电话：压住、去重与已播记录都随 active 一起销毁。 */
export interface NarrationState {
  userSpeaking: boolean;
  queue: Map<string, PendingNarration>;
  inFlight: { narration: VoiceWorkNarration; rejectionCount: number } | null;
  spokenWorkItemIds: Set<string>;
  /** 每件活已经播出去的进度条数（§2 上限）。键是真实 workItemId，不是 milestone 合成键。 */
  milestoneCounts: Map<string, number>;
  /** 上一条进度真正注入的时刻；间隔下限据此判。0 = 本通电话还没播过进度。 */
  lastMilestoneAt: number;
  /** 本通电话第一次派活的时刻，用来兑现首条进度的最小延迟。 */
  firstDispatchAt: number;
}

/** 队列只认这一小块 session：id/上游用来注入与留痕，narration 是它自己的状态。 */
export interface NarrationSession {
  id: string;
  neoSessionId: string;
  upstream: VoiceTransportHandle;
  narration: NarrationState;
}

export function createNarrationState(): NarrationState {
  return {
    userSpeaking: false,
    queue: new Map(),
    inFlight: null,
    spokenWorkItemIds: new Set(),
    milestoneCounts: new Map(),
    lastMilestoneAt: 0,
    firstDispatchAt: 0,
  };
}

/**
 * 终态回流 → 一句塞进实时会话的话（发言人协议 §2.2）。
 *
 * `[BACKEND] ` 前缀是给模型看的来源标记（用户消息带 `[USER] `），prompt 里明令不许念出来。
 * 措辞写死不留自由发挥空间：模型会把这段话当事实原样转述，失败尤其不能让它自己润色。
 */
function formatNarration(narration: VoiceWorkNarration): string {
  const who = narration.speaker ? `${narration.speaker.displayName}：` : '';
  // 「停旧的」回报（§1）：整句台词已由 buildStopNarration 算好，这里不再拼词。
  // 措辞只有一个家，避免「停稳了没有」这件事在两个模块里各写一半而说法打架。
  if (narration.status === 'announcement') {
    return `[BACKEND] ${who}${narration.summary}`;
  }
  if (narration.status === 'failed') {
    const reason = narration.summary || '未给出原因';
    return `[BACKEND] ${who}「${narration.title}」失败了，没有完成，原因：${reason}。`
      + '如实告诉用户这件事失败了，绝不要说它已经完成、已经写入或已经生效。';
  }
  // 待核验（X5.5-A2-a）：run 跑完了但没留下任何产物。这一档最容易被润色成「做完了」，
  // 所以和失败一样把台词写死，不给「已结束」这种可润色的状态名词留空间。
  if (narration.status === 'unverified') {
    return `[BACKEND] ${who}「${narration.title}」跑完了，但没有留下任何产物，不能算做完。${narration.summary}`.trim()
      + '\n如实告诉用户这件事跑完了但还没核验，请他自己确认一下；'
      + '绝不要说它已经完成、已经写入或已经生效。';
  }
  return `[BACKEND] ${who}「${narration.title}」做完了。${narration.summary}`.trim();
}

function injectNarration(session: NarrationSession, narration: VoiceWorkNarration, rejectionCount = 0): void {
  if (session.narration.spokenWorkItemIds.has(narration.workItemId)) return;
  const { upstream } = session;
  if (upstream.kind !== 'relay') {
    // WebRTC 形态媒体不经 Host，注入通道要走 Renderer 的 data channel，尚未实现。
    // 静默 no-op = 用户永远等不到那句话且查不出为什么，必须留痕。
    logger.warn('narration dropped: transport has no inject channel', { provider: upstream.provider });
    return;
  }
  upstream.injectItem(formatNarration(narration));
  // §4.3：注入侧同样带三元组，与派活侧对上就能还原一条完整链路。
  logger.info('narration injected', {
    workItemId: narration.workItemId,
    voiceSessionId: session.id,
    neoSessionId: session.neoSessionId,
    status: narration.status,
  });
  session.narration.inFlight = { narration, rejectionCount };
  session.narration.spokenWorkItemIds.add(narration.workItemId);
  if (narration.status === 'milestone') {
    const owner = milestoneOwner(narration.workItemId);
    const state = session.narration;
    state.milestoneCounts.set(owner, (state.milestoneCounts.get(owner) ?? 0) + 1);
    // 间隔从**真正注入**那一刻起算，不从入队起算——被压住的那段时间不该消耗间隔额度。
    state.lastMilestoneAt = Date.now();
  }
}

/**
 * 合成键形如 `<workItemId>:<某种后缀>-<n>`（`:milestone-`、`:blocked-`、`:stop-`…）；
 * 取回它属于哪件活。
 *
 * **按第一个冒号切，不按后缀名枚举**：上一版写死认 `:milestone-`，于是 R3 加
 * `:blocked-` 前缀的那一刻，每条卡点播报都被算成「另一件活」，per-item 上限对它
 * 整个失效——一件活能把整通电话说满，而日志里看不出任何异常。真实 workItemId 由
 * `voice-work-<ts>-<rand>` 生成，本身不含冒号，所以按冒号切是稳的，且以后再加什么
 * 后缀都默认被算进同一件活，不用回来改这里。
 */
function milestoneOwner(workItemId: string): string {
  const at = workItemId.indexOf(':');
  return at === -1 ? workItemId : workItemId.slice(0, at);
}

/**
 * 进度该不该播（§2 三条闸，缺一条就变成碎碎念）。
 *
 * 这三条只管进度，**终态一条都不受限**——结论永远值得说。
 *
 * worth-hearing（R3）在这三条上各让一步，**且只在这三条上**：
 *   - 首条延迟窗、最小间隔：直接豁免。这两条防的是碎碎念，而转折点不是碎碎念。
 *   - per-item 上限：允许**超一格**，不是无限。上限防的是一件活把整通电话说满，
 *     这个风险对转折点同样成立；但「三条进度已经播满，第四条是『这事要花钱』」
 *     被静默吞掉，是把最该听见的那条正好挡在门外。让一格 + 留痕是两害相权。
 *
 * userSpeaking 抢占不在这里，也不该在这里被豁免——见 enqueueOrInjectNarration。
 */
function milestoneAllowed(session: NarrationSession, narration: VoiceWorkNarration, now: number): boolean {
  const state = session.narration;
  const owner = milestoneOwner(narration.workItemId);
  const worthHearing = narration.worthHearing === true;
  const spoken = state.milestoneCounts.get(owner) ?? 0;
  const cap = VOICE_MILESTONE_MAX_PER_WORK_ITEM + (worthHearing ? 1 : 0);
  if (spoken >= cap) {
    logger.info('milestone dropped: per work item cap', { voiceSessionId: session.id, workItemId: owner, worthHearing });
    return false;
  }
  if (worthHearing) {
    // 超额那一格必须留痕：不然「上限之外还播了一条」这件事在日志里查不到，
    // 而它正是将来判断「这个豁免有没有被滥用」的唯一依据。
    if (spoken >= VOICE_MILESTONE_MAX_PER_WORK_ITEM) {
      logger.info('milestone over cap: worth-hearing overflow slot used', {
        voiceSessionId: session.id,
        workItemId: owner,
        spoken,
      });
    }
    return true;
  }
  // 首条延迟：不让「我开始做 X 了」和第一条进度挤在同一口气里。
  if (state.firstDispatchAt && now - state.firstDispatchAt < VOICE_MILESTONE_FIRST_DELAY_MS) {
    logger.info('milestone dropped: first delay window', { voiceSessionId: session.id });
    return false;
  }
  if (state.lastMilestoneAt && now - state.lastMilestoneAt < VOICE_MILESTONE_MIN_INTERVAL_MS) {
    logger.info('milestone dropped: min interval', { voiceSessionId: session.id });
    return false;
  }
  return true;
}

export function enqueueOrInjectNarration(session: NarrationSession, narration: VoiceWorkNarration): void {
  const state = session.narration;
  if (state.spokenWorkItemIds.has(narration.workItemId) || state.queue.has(narration.workItemId)) return;
  const now = Date.now();
  const isMilestone = narration.status === 'milestone';
  // 进度的三条闸在**入口**判，不在出口——被闸掉的进度连队都不该排，
  // 排了就会在用户说完话之后冒出来一句早已过期的进展。
  if (isMilestone && !milestoneAllowed(session, narration, now)) return;
  const upstreamResponding = session.upstream.kind === 'relay' && session.upstream.isResponding();
  // 这里**没有** worthHearing 分支，而且不许长出来（R3 硬边界）：用户正在说话时，
  // 再重要的转折也只能排队等他说完。「重要」是相对其它播报说的，不是相对用户说的。
  if (!state.userSpeaking && !upstreamResponding) {
    injectNarration(session, narration);
    return;
  }
  // 只把真实用户轮算进压制次数；单纯撞上模型响应窗不消耗用户轮额度。
  state.queue.set(narration.workItemId, {
    narration,
    suppressedTurns: state.userSpeaking ? 1 : 0,
    rejectionCount: 0,
    enqueuedAt: now,
  });
}

export function markNarrationUserTurn(session: NarrationSession): void {
  const state = session.narration;
  state.userSpeaking = true;
  for (const [workItemId, pending] of state.queue) {
    // 用户一开口，排队的进度**当场全丢**（不等两轮）：他已经在说别的事了，
    // 等他说完再补一句几十秒前的进展，是在打断他而不是在帮他。终态不丢，只排队。
    if (pending.narration.status === 'milestone') {
      state.queue.delete(workItemId);
      logger.info('milestone dropped: user started speaking', { voiceSessionId: session.id, workItemId });
      continue;
    }
    pending.suppressedTurns += 1;
    if (pending.suppressedTurns < 2) continue;
    state.queue.delete(workItemId);
    logger.info('narration dropped after two suppressed user turns', {
      voiceSessionId: session.id,
      workItemId,
    });
  }
}

export function flushNarrationQueue(session: NarrationSession): void {
  const state = session.narration;
  state.userSpeaking = false;
  state.inFlight = null;
  // 每次 response.done 只放一条。injectItem 会立即请求下一次 response，
  // 一次清空多条会让这些 response.create 互相碰撞。
  // 放行之前先把过期进度清掉：进度是过程量，滞留超过保质期就只会误导。
  // 终态不设保质期——结论晚说也是实话。
  const now = Date.now();
  for (const [workItemId, pending] of state.queue) {
    if (pending.narration.status !== 'milestone') continue;
    if (now - pending.enqueuedAt < VOICE_MILESTONE_STALE_MS) continue;
    state.queue.delete(workItemId);
    logger.info('milestone dropped: stale', { voiceSessionId: session.id, workItemId });
  }
  const next = state.queue.entries().next().value as [string, PendingNarration] | undefined;
  if (!next) return;
  state.queue.delete(next[0]);
  injectNarration(session, next[1].narration, next[1].rejectionCount);
}

export function handleNarrationInjectionRejected(session: NarrationSession, message: string): void {
  const state = session.narration;
  const failed = state.inFlight;
  state.inFlight = null;
  if (!failed) {
    logger.warn('unmatched narration injection rejection', { voiceSessionId: session.id, message });
    return;
  }
  const { narration, rejectionCount } = failed;
  if (rejectionCount >= 1) {
    logger.warn('narration injection dropped after retry', {
      voiceSessionId: session.id,
      workItemId: narration.workItemId,
      message,
    });
    return;
  }
  // 进度被拒就丢，不重试:重试意味着过一会儿播一条更陈旧的进展,而它本来就是过程量。
  // 被拒这次仍然算消耗掉一格额度——这个偏差是**故意偏向安静**的:进度这个功能的风险
  // 是碎碎念,不是少说一句。
  if (narration.status === 'milestone') {
    logger.info('milestone dropped: injection rejected, not retried', {
      voiceSessionId: session.id,
      workItemId: narration.workItemId,
    });
    return;
  }
  state.spokenWorkItemIds.delete(narration.workItemId);
  state.queue.set(narration.workItemId, {
    narration,
    suppressedTurns: 0,
    rejectionCount: rejectionCount + 1,
    enqueuedAt: Date.now(),
  });
  logger.info('narration injection rejected; queued one retry', {
    voiceSessionId: session.id,
    workItemId: narration.workItemId,
    message,
  });
}
