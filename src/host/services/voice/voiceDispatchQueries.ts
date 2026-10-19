// voiceAgentCoordinator 的只读查询层（N-MAXLINES-MINEFIELD-2-FU1-S3 逐字拆出）：
// 编号、task_status / recent_files / current_time 的答话文案。行为零变化，只做代码搬家。
import { VOICE_RECENT_FILE_LIMIT } from '../../../shared/constants/voice';
import type { VoiceWorkItemStatus } from '../../../shared/contract/voice';
import { getIncompleteTasks } from '../planning/taskStore';
import { getSessionManager } from '../infra/sessionManager';
import { voiceTaskOrdinal } from './voiceTaskReference';
import { TERMINAL, type LedgerState } from './voiceDispatchTypes';

/**
 * 播给用户的编号 = 这件活在账本里的**登记次序**（items 只 set 不 delete，一通电话里恒定）。
 *
 * 刻意不用「当前存活项里的第几个」：活会陆续落终态，那种编号每落一件就整体前移——
 * 用户听到的「2 号」和他下一句说出口的「2 号」可能已经不是同一件事，而这条链上编错号
 * 的代价是停错活。代价是号码会有断档（3 件跑完后新的一件是「4」），听着略怪但不会指错。
 */
function ordinalOf(state: LedgerState, workItemId: string): number {
  return voiceTaskOrdinal([...state.items.values()], workItemId);
}

// ============================================================================
// 只读查询
// ============================================================================

/**
 * 现在几点（真机 2026-07-28：用户问「现在几点了？」，通话 brain 答「我这边看不到具体时间」，
 * 用户只好说「通过 computer use 来看」才绕出去——语音层拿不到时间是产品缺陷不是模型笨）。
 * 走工具而不是往 instructions 里注入时间：instructions 只在建连和焦点变化时刷新，
 * 注进去的时间会随通话变旧，而这是个「问了就该准」的问题。
 */
export function describeCurrentTime(): string {
  const now = new Date();
  const text = now.toLocaleString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric',
    weekday: 'long', hour: '2-digit', minute: '2-digit',
  });
  return `现在是${text}。`;
}

/**
 * 「现在在跑什么」。分两组，因为这两组**能不能被指挥是不一样的**：
 *
 * 上面一组是我派出去的 run，带编号，可以拿编号定向 steer / cancel；下面一组是执行侧
 * 计划里的条目，它们不是 run，停不了也改不了。上一版把两组平铺成同一串 `- xxx`，
 * 通话 brain 无从分辨，只能把「停掉那个」翻译成「停手上那件」——指挥台的第一课是
 * 先让人看清哪些东西是可以被指的。
 */
export function describeStatus(state: LedgerState): string {
  const lines: string[] = [];
  const live = [...state.items.values()].filter((item) => !TERMINAL.includes(item.status));
  if (live.length) {
    lines.push('我派出去的活（要改方向或叫停，把编号传给 target）：');
    for (const item of live) {
      lines.push(`${ordinalOf(state, item.id)}. ${item.title}（${statusText(item.status)}）`);
    }
  }
  const planned = getIncompleteTasks(state.neoSessionId);
  if (planned.length) {
    lines.push('执行侧计划里还没做完的（这些不是我派的活，改不了也停不了）：');
    for (const task of planned) lines.push(`- ${task.subject}（${task.status}）`);
  }
  if (!lines.length) return '当前没有进行中的任务。';
  return lines.join('\n');
}

/** 此刻有几件活还没落终态。>1 时口播必须点名是哪件的进度，否则用户不知道在讲谁。 */
export function liveWorkCount(state: LedgerState): number {
  let count = 0;
  for (const item of state.items.values()) if (!TERMINAL.includes(item.status)) count += 1;
  return count;
}

export function statusText(status: VoiceWorkItemStatus): string {
  switch (status) {
    case 'queued': return '排队中';
    case 'running': return '进行中';
    case 'done': return '已完成';
    // 终态项已被 describeStatus 滤掉，这几支只为穷尽联合；措辞仍按「不可润色」写，
    // 免得哪天有人把终态也列进去，就地变成一句可以被润成「做完了」的话。
    case 'unverified': return '跑完了但没看到产物，不能算做完';
    case 'failed': return '失败';
    case 'cancelled': return '已取消';
  }
}

/**
 * 「你在动哪些文件」。真焦点优先——用户问的是「我现在看的这个」，不是「这轮碰过的一堆」。
 * 没有焦点（CLI 态 / 右栏没开东西）时退回刮会话里发生过的文件动作。
 */
export async function describeFocusedFiles(state: LedgerState): Promise<string> {
  const focus = state.focus;
  if (focus?.filePath) {
    const lines = [`当前打开的是 ${focus.filePath}${focus.unsaved ? '（有未保存改动）' : ''}`];
    if (focus.selectedElement) lines.push(`选中的元素：${focus.selectedElement}`);
    return lines.join('\n');
  }
  if (focus?.view && !focus.view.startsWith('preview:')) {
    return `右栏现在看的是${focus.view}，没有打开具体文件。`;
  }
  return describeRecentFiles(state.neoSessionId);
}

/** 兜底：从会话消息里工具调用的 file_path 反推「这轮动过什么」。 */
async function describeRecentFiles(neoSessionId: string): Promise<string> {
  const session = await getSessionManager().getSession(neoSessionId, 30);
  const paths = new Set<string>();
  for (const message of session?.messages ?? []) {
    for (const call of message.toolCalls ?? []) {
      const filePath = (call.arguments as Record<string, unknown> | undefined)?.file_path;
      if (typeof filePath === 'string' && filePath) paths.add(filePath);
    }
  }
  if (!paths.size) return '本次会话还没有读写过文件。';
  return [...paths].slice(-VOICE_RECENT_FILE_LIMIT).map((path) => `- ${path}`).join('\n');
}
