import { visibleHistoryMessageWhere } from '../core/repositories/sessionRepositoryParsers';
import { createHash } from 'node:crypto';
import { getDatabase } from '../core/databaseService';
import { getSessionManager } from '../infra/sessionManager';
import { getConfigService } from '../core/configService';
import { getAuthService } from '../auth/authService';
import { buildRuntimeModelOptions } from '../../../shared/modelRuntime';
import { resolveSessionDefaultModelConfig } from '../core/sessionDefaults';
import { COMPANION_LIMITS as L } from '../../../shared/constants/companion';
import { projectGrant, type CompanionRead, type CompanionLibrary, type CompanionHistory } from '../../../shared/contract/companionLibrary';
import { SESSION_PROJECT_PINNED_METADATA_KEY, UNSORTED_PROJECT_ID } from '../../../shared/contract/project';
import type { CompanionCommand } from '../../../shared/contract/companion';
import type { CompanionGateway } from './CompanionGateway';
import { stripInterruptionMarkers } from './projectCompanionEvent';
import { MODEL_OVERRIDE_METADATA_KEY, persistModelOverride, readPersistedModelOverride } from '../../session/modelOverridePersistence';
import { getProviderHealthMonitor } from '../../model/providerHealthMonitor';
import { getModelSessionState } from '../../session/modelSessionState';
import { createLogger } from '../infra/logger';
import type { AppSettings } from '../../../shared/contract';

const logger = createLogger('CompanionLibrary');

/**
 * 手机的模型下拉直接吃这个列表。可用性由 buildRuntimeModelOptions 负责（没配 key 的 provider
 * 不进列表），默认项由电脑自己的新会话默认模型决定——列表顺序是桌面切换面板的 provider 常量序
 * （moonshot 排第一），拿它当默认等于让手机替用户挑了一家他从没选过的（FB-141）。
 */
function companionModelOptions(
  settings: AppSettings | null | undefined,
  hostDefault: { provider: string; model: string },
): CompanionLibrary['models'] {
  return buildRuntimeModelOptions(settings).map(({ provider, model, label, providerLabel }) => ({
    provider, model, label, providerLabel,
    ...(provider === hostDefault.provider && model === hostDefault.model ? { isDefault: true as const } : {}),
    // 配了 key 不等于能用：key 被拒（403）的 provider 照样在列表里。刚因鉴权失败要换模型的人
    // 不该再换到它身上（build 45 真机：默认的 custom-team-relay 就是被拒的那家）。
    ...(getProviderHealthMonitor().getHealth(provider)?.status === 'unavailable' ? { recentlyFailed: true as const } : {}),
  }));
}

/**
 * 这条会话下一次执行**真正会用**的模型：会话 override（内存优先，重启后看持久化标记）否则电脑默认。
 * 与 routes/agent.ts 的运行解析链同口径。不能报 sessions 表的 model 列——那是建会话时的快照，
 * 没切换过的会话运行时跟随电脑默认（build 45 真机：胶囊写 glm-5.3-flash，实跑 custom-team-relay/LongCat-2.0）。
 */
function sessionRunModel(session: { id: string; metadata?: Record<string, unknown> }, hostDefault: { provider: string; model: string }) {
  const override = getModelSessionState().getOverride(session.id) ?? readPersistedModelOverride(session);
  return override && override.adaptive !== true ? { provider: override.provider, model: override.model } : { provider: hostDefault.provider, model: hostDefault.model };
}

/** Page-level form of canAccessSession(): grants plus the cleanup queue, so a session queued for
 * cleanup stays hidden even if the store lists it again (cloud sync can flip isDeleted back before
 * cleanup drains the queue). Its sessionVisible check is deliberately absent, not forgotten: that
 * dep resolves to getSession(id, { userId: owner }), whose filters (is_deleted = 0 and the same
 * owner) are exactly the ones listSessions() already applied, so it is true for every row here. */
function sessionAccessible(grants: readonly string[], forgotten: ReadonlySet<string>, session: { id: string; projectId?: string | null }): boolean {
  if (session.id.startsWith('project:') || forgotten.has(session.id)) return false;
  if (grants.includes(session.id)) return true;
  return !!session.projectId && grants.includes(projectGrant(session.projectId));
}

/**
 * 这个项目此刻建不了会话：普通项目要有工作目录；「未分类」是无工作目录会话的保留桶，桌面端在里面新建对话
 * 从来不要求目录（运行时兜底到应用工作目录），手机端与之一致。build 46 按「无目录即不可建」把它也挡了，
 * 而爸的电脑只有这一个项目 ⇒ 手机上一个会话都建不了（2026-09-16 真机）。
 */
function missingWorkspace(project: { id: string; workspacePath?: string | null }): boolean {
  return !project.workspacePath && project.id !== UNSORTED_PROJECT_ID;
}

/** Mobile reuses the desktop repositories, model catalogue and session services. */
export class CompanionLibraryService {
  constructor(private readonly gateway: CompanionGateway, private readonly isRunning: (id: string) => boolean) {}

  private session(id: string) {
    return getDatabase().getSession(id, { userId: getAuthService().getCurrentUser()?.id ?? null });
  }

  projects() {
    // workspacePath 用于手机侧同名项目消歧（fix5-③）：名字可重复（不同目录各建过一个
    // workspace），路径不会。缺路径的存量项目照发 null，手机侧降级不显示消歧标签。
    return getDatabase().getProjectRepo().listProjects().map(p => ({ id: p.id, name: p.name, workspacePath: p.workspacePath ?? null }));
  }

  sessionExists(id: string): boolean { return this.session(id) !== null; }

  sessionProject(id: string): string | null { return this.session(id)?.projectId ?? null; }

  workspaceOf(id: string): string | null {
    const session = this.session(id);
    if (!session) return null;
    if (session.workingDirectory) return session.workingDirectory;
    if (!session.projectId) return null;
    return getDatabase().getProjectRepo().getProject(session.projectId)?.workspacePath ?? null;
  }

  async read(deviceId: string, request: CompanionRead): Promise<CompanionLibrary | CompanionHistory> {
    const db = getDatabase();
    const handle = db.getDb();
    if (!handle) throw new Error('COMPANION_LIBRARY_UNAVAILABLE');
    const owner = getAuthService().getCurrentUser()?.id ?? null;
    if (request.kind === 'artifacts') throw new Error('COMPANION_UNSUPPORTED_ACTION');
    if (request.kind === 'history') {
      if (!this.session(request.sessionId)) throw new Error('COMPANION_SESSION_NOT_FOUND');
      const rows = handle.prepare(`SELECT rowid AS cursor, id, role, content, timestamp FROM messages
        WHERE session_id = ? AND ${visibleHistoryMessageWhere('messages')} AND role IN ('user','assistant')
          AND (? = 0 OR rowid < ?) ORDER BY rowid DESC LIMIT ?`).all(request.sessionId, request.offset, request.offset, L.syncPageSize) as
          { cursor: number; id: string; role: string; content: string; timestamp: number }[];
      const messages: CompanionHistory['messages'] = [];
      let bytes = 512; let nextOffset: number | null = null; let consumed = 0;
      for (const row of rows) {
        // 历史里的中断标记同样不出手机边界（与实时事件同一个函数）；只剩标记的助手行跳过，但分页游标照常前进
        const content = row.role === 'assistant' ? stripInterruptionMarkers(row.content) : row.content;
        if (row.role === 'assistant' && !content.trim() && row.content.trim()) { nextOffset = row.cursor; consumed += 1; continue; }
        const message = { id: row.id, role: row.role, content: content.slice(0, L.historyMessageCharacters), timestamp: row.timestamp,
          truncated: content.length > L.historyMessageCharacters };
        const size = Buffer.byteLength(JSON.stringify(message));
        if (bytes + size > L.historyByteLimit) break;
        messages.push(message); bytes += size; nextOffset = row.cursor; consumed += 1;
      }
      if (consumed === rows.length && rows.length < L.syncPageSize) nextOffset = null;
      return { sessionId: request.sessionId, messages: messages.reverse(), nextOffset };

    }
    const grants = this.gateway.grants(deviceId);
    const forgotten = this.gateway.forgottenSessions();
    const sessions: ReturnType<typeof db.listSessions> = [];
    for (let offset = 0; ; offset += L.librarySessionLimit) {
      const page = db.listSessions(L.librarySessionLimit, offset, true, owner);
      for (const session of page) {
        if (sessionAccessible(grants, forgotten, session)) sessions.push(session);
      }
      if (page.length < L.librarySessionLimit) break;
    }
    // 「有没有授权」与「此刻能不能建」是两个问题。判据与 mutate() 里 session.create 的宿主前提同一个函数。
    const projects = this.projects().filter(p => grants.includes(projectGrant(p.id)) || sessions.some(s => s.projectId === p.id))
      .map(p => {
        const createBlocked = !grants.includes(projectGrant(p.id)) ? 'not_granted' as const : missingWorkspace(p) ? 'no_workspace' as const : null;
        return { ...p, canCreate: createBlocked === null, ...(createBlocked ? { createBlocked } : {}) };
      });
    const hostDefault = resolveSessionDefaultModelConfig();
    const models = companionModelOptions(getConfigService().getSettings(), hostDefault);
    return { projects, models, nextOffset: request.offset + L.syncPageSize < sessions.length ? request.offset + L.syncPageSize : null, sessions: sessions.slice(request.offset, request.offset + L.syncPageSize).map(s => ({ id: s.id, title: s.title, projectId: s.projectId ?? null,
      updatedAt: s.updatedAt, archived: s.status === 'archived', ...sessionRunModel(s, hostDefault) })) };
  }

  async mutate(command: CompanionCommand): Promise<Record<string, unknown>> {
    const sm = getSessionManager();
    const guard = () => {
      const allowed = command.action === 'session.create' ? this.gateway.grants(command.deviceId).includes(command.sessionId) : this.gateway.canAccessSession(command.deviceId, command.sessionId);
      if (!allowed) throw new Error('COMPANION_SCOPE_DENIED');
      if (command.action !== 'session.create' && this.isRunning(command.sessionId)) throw new Error('COMPANION_SESSION_BUSY');
    };
    const commit = (write: () => void) => { guard(); this.gateway.commitMutation(command, write, { sessionId: command.sessionId }); };
    if (command.action === 'session.create') {
      if (!this.gateway.grants(command.deviceId).includes(command.sessionId)) throw new Error('COMPANION_SCOPE_DENIED');
      const project = getDatabase().getProjectRepo().getProject(command.sessionId.slice('project:'.length));
      if (!project || project.status === 'archived' || missingWorkspace(project)) throw new Error('COMPANION_PROJECT_UNAVAILABLE');
      const model = this.model(command.payload.provider, command.payload.model);
      // The command reservation is durable before this starts; identity is independent of response delivery.
      const id = `mobile-${createHash('sha256').update(`${command.deviceId}:${command.commandId}`).digest('hex')}`;
      const session = await sm.createSession({ id, commit: write => { guard();
        const current = getDatabase().getProjectRepo().getProject(project.id);
        if (!current || current.status === 'archived' || current.workspacePath !== project.workspacePath) throw new Error('COMPANION_PROJECT_CHANGED');
        this.gateway.commitMutation(command, write, { sessionId: id });
      }, title: command.payload.title, workingDirectory: project.workspacePath || undefined,
        modelConfig: { provider: model.provider, model: model.model },
        // 归属是手机明确选的：「未分类」没有工作目录，首轮运行兜底补目录时 sessionManager 会把未分类会话重算进
        // 自动项目，会话就跑出这台设备的项目授权（命令回执/事件/历史全被拒，手机卡在「还没收到电脑确认」）。
        // 边界：手机建的每个会话都钉、且没有解钉途径——之后在电脑上给它设工作目录也不会再归进对应项目；
        // 这是有意的：会话必须留在建它的那台手机的授权范围里。
        metadata: { [MODEL_OVERRIDE_METADATA_KEY]: { provider: model.provider, model: model.model, setAt: Date.now() }, [SESSION_PROJECT_PINNED_METADATA_KEY]: true } });
      if (session.projectId !== project.id) throw new Error('COMPANION_PROJECT_CHANGED');
      getModelSessionState().setOverride(session.id, { provider: model.provider, model: model.model });
      return { sessionId: session.id };
    }
    if (!this.gateway.canAccessSession(command.deviceId, command.sessionId) || !this.session(command.sessionId)) throw new Error('COMPANION_SCOPE_DENIED');
    if (this.isRunning(command.sessionId)) throw new Error('COMPANION_SESSION_BUSY');
    if (command.action === 'session.rename') await sm.updateSession(command.sessionId, { title: command.payload.title }, { commit });
    else if (command.action === 'session.archive') {
      if (command.payload.archived) await sm.archiveSession(command.sessionId, commit); else await sm.unarchiveSession(command.sessionId, commit);
    } else if (command.action === 'session.delete') { await sm.deleteSession(command.sessionId, commit); await this.cleanup(); }
    else if (command.action === 'session.model') {
      const model = this.model(command.payload.provider, command.payload.model);
      const override = { provider: model.provider, model: model.model };
      if (!await persistModelOverride(command.sessionId, override, commit)) throw new Error('COMPANION_MODEL_NOT_SAVED');
      getModelSessionState().setOverride(command.sessionId, override);
    } else throw new Error('COMPANION_UNSUPPORTED_ACTION');
    return { sessionId: command.sessionId };
  }

  async cleanup(): Promise<void> {
    try {
      const db = getDatabase().getDb();
      if (!db) { logger.warn('Companion cleanup skipped: database unavailable, jobs stay queued'); return; }
      for (const { session_id: id } of db.prepare('SELECT session_id FROM companion_session_cleanup').all() as { session_id: string }[]) {
        try {
          await getSessionManager().cleanupDeletedSession(id);
          this.gateway.forgetSession(id);
          db.prepare('DELETE FROM companion_session_cleanup WHERE session_id = ?').run(id);
        }
        catch (error) {
          // Retain the cleanup job across Host restarts; the deletion receipt stays committed.
          // Silence would hide a row that retries on every boot and never succeeds.
          logger.warn('Companion deleted-session cleanup failed, will retry next boot', { sessionId: id, error });
        }
      }
    } catch (error) {
      logger.warn('Companion deleted-session cleanup unavailable', error);
    }
  }

  private model(provider: string, model: string) {
    const found = buildRuntimeModelOptions(getConfigService().getSettings()).find(m => m.provider === provider && m.model === model);
    if (!found) throw new Error('COMPANION_MODEL_UNAVAILABLE');
    return found;
  }
}
