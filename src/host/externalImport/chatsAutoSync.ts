// ============================================================================
// Chats auto sync - 启动时自动导入新的 Claude Code / Codex 聊天
// ============================================================================
//
// 仅 mode==='on' 才导入；手动导入与自动同步共用同一个 in-flight promise（单飞），
// 并发点击不会触发第二轮导入。去重由宿主侧 session_fork_portability_imports 台账负责。

import type { RecentExternalChatImportResult } from '../../shared/contract/agentEngine';
import { getAgentEngineHistoryImportService } from '../services/agentEngine/agentEngineHistoryImport';
import { createLogger } from '../services/infra/logger';
import { currentSessionForkOwnerScopeId } from '../services/sessionFork/ownerScope';
import {
  readChatsSyncState,
  writeChatsSyncState,
  type ChatsSyncMode,
  type ChatsSyncState,
} from './chatsSyncPreference';

const logger = createLogger('ChatsAutoSync');

let inFlight: Promise<RecentExternalChatImportResult[]> | null = null;
let importedListener: (() => void) | undefined;

/** 单飞的批量导入：手动 IPC 与自动同步共用。 */
export function importRecentChatsSingleFlight(): Promise<RecentExternalChatImportResult[]> {
  if (!inFlight) {
    // ownerScopeId 必须与 importSessionFork 台账口径逐字同值（单一真源见 ownerScope 模块）。
    inFlight = getAgentEngineHistoryImportService()
      .importRecentChats({ ownerScopeId: currentSessionForkOwnerScopeId() })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

export interface ChatsAutoSyncOptions {
  /** 有新会话被导入时调用（宿主导入本身不广播会话列表更新）；缺省用 startChatsAutoSync 注册的监听。 */
  onImported?: () => void;
  now?: () => number;
}

/** 启动入口：注册「有新导入」监听并跑一轮（不 await 也安全，永不抛）。 */
export function startChatsAutoSync(onImported: () => void): Promise<void> {
  importedListener = onImported;
  return runChatsAutoSync();
}

/** mode==='on' 才跑一轮；永不抛，失败只记日志。 */
export async function runChatsAutoSync(options: ChatsAutoSyncOptions = {}): Promise<void> {
  const state = readChatsSyncState();
  if (state.mode !== 'on') return;
  try {
    const results = await importRecentChatsSingleFlight();
    const imported = results.filter((item) => item.status === 'imported').length;
    writeChatsSyncState({ mode: 'on', lastRun: { at: (options.now ?? Date.now)(), imported } });
    if (imported > 0) (options.onImported ?? importedListener)?.();
  } catch (err) {
    logger.warn('Chats auto sync failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

export function getChatsSyncState(): ChatsSyncState {
  return readChatsSyncState();
}

/** 设置模式；从 off/paused 切到 on 会立即同步一轮再返回。 */
export async function setChatsSyncMode(
  mode: ChatsSyncMode,
  options: ChatsAutoSyncOptions = {},
): Promise<ChatsSyncState> {
  const previous = readChatsSyncState();
  writeChatsSyncState({ mode, ...(previous.lastRun ? { lastRun: previous.lastRun } : {}) });
  if (mode === 'on' && previous.mode !== 'on') await runChatsAutoSync(options);
  return readChatsSyncState();
}
