import { visibleHistoryMessageWhere } from '../core/repositories/sessionRepositoryParsers';
import { createHash } from 'node:crypto';
import { getDatabase } from '../core/databaseService';
import { getSessionManager } from '../infra/sessionManager';
import { getConfigService } from '../core/configService';
import { getAuthService } from '../auth/authService';
import { buildRuntimeModelOptions } from '../../../shared/modelRuntime';
import { COMPANION_LIMITS as L } from '../../../shared/constants/companion';
import { projectGrant, type CompanionRead, type CompanionLibrary, type CompanionHistory } from '../../../shared/contract/companionLibrary';
import type { CompanionCommand } from '../../../shared/contract/companion';
import type { CompanionGateway } from './CompanionGateway';
import { MODEL_OVERRIDE_METADATA_KEY, persistModelOverride } from '../../session/modelOverridePersistence';
import { getModelSessionState } from '../../session/modelSessionState';
import { createLogger } from '../infra/logger';

const logger = createLogger('CompanionLibrary');

/** Mobile reuses the desktop repositories, model catalogue and session services. */
export class CompanionLibraryService {
  constructor(private readonly gateway: CompanionGateway, private readonly isRunning: (id: string) => boolean) {}

  private session(id: string) {
    return getDatabase().getSession(id, { userId: getAuthService().getCurrentUser()?.id ?? null });
  }

  projects() {
    return getDatabase().getProjectRepo().listProjects().map(p => ({ id: p.id, name: p.name }));
  }

  sessionProject(id: string): string | null { return getDatabase().getSession(id, { includeDeleted: true, userId: getAuthService().getCurrentUser()?.id ?? null })?.projectId ?? null; }

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
      let bytes = 512; let nextOffset: number | null = null;
      for (const row of rows) {
        const message = { id: row.id, role: row.role, content: row.content.slice(0, L.historyMessageCharacters), timestamp: row.timestamp,
          truncated: row.content.length > L.historyMessageCharacters };
        const size = Buffer.byteLength(JSON.stringify(message));
        if (bytes + size > L.historyByteLimit) break;
        messages.push(message); bytes += size; nextOffset = row.cursor;
      }
      if (messages.length === rows.length && rows.length < L.syncPageSize) nextOffset = null;
      return { sessionId: request.sessionId, messages: messages.reverse(), nextOffset };

    }
    const sessions: ReturnType<typeof db.listSessions> = [];
    for (let offset = 0; ; offset += L.librarySessionLimit) {
      const page = db.listSessions(L.librarySessionLimit, offset, true, owner);
      sessions.push(...page.filter(s => this.gateway.canAccessSession(deviceId, s.id)));
      if (page.length < L.librarySessionLimit) break;
    }
    const grants = this.gateway.grants(deviceId);
    const projects = this.projects().filter(p => grants.includes(projectGrant(p.id)) || sessions.some(s => s.projectId === p.id))
      .map(p => ({ ...p, canCreate: grants.includes(projectGrant(p.id)) }));
    const models = buildRuntimeModelOptions(getConfigService().getSettings()).map(({ provider, model, label, providerLabel }) => ({ provider, model, label, providerLabel }));
    return { projects, models, nextOffset: request.offset + L.syncPageSize < sessions.length ? request.offset + L.syncPageSize : null, sessions: sessions.slice(request.offset, request.offset + L.syncPageSize).map(s => ({ id: s.id, title: s.title, projectId: s.projectId ?? null,
      updatedAt: s.updatedAt, archived: s.status === 'archived', provider: s.modelConfig.provider, model: s.modelConfig.model })) };
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
      if (!project || project.status === 'archived' || !project.workspacePath) throw new Error('COMPANION_PROJECT_UNAVAILABLE');
      const model = this.model(command.payload.provider, command.payload.model);
      // The command reservation is durable before this starts; identity is independent of response delivery.
      const id = `mobile-${createHash('sha256').update(`${command.deviceId}:${command.commandId}`).digest('hex')}`;
      const session = await sm.createSession({ id, commit: write => { guard();
        const current = getDatabase().getProjectRepo().getProject(project.id);
        if (!current || current.status === 'archived' || current.workspacePath !== project.workspacePath) throw new Error('COMPANION_PROJECT_CHANGED');
        this.gateway.commitMutation(command, write, { sessionId: id });
      }, title: command.payload.title, workingDirectory: project.workspacePath,
        modelConfig: { provider: model.provider, model: model.model },
        metadata: { [MODEL_OVERRIDE_METADATA_KEY]: { provider: model.provider, model: model.model, setAt: Date.now() } } });
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
    const db = getDatabase().getDb();
    if (!db) { logger.warn('Companion cleanup skipped: database unavailable, jobs stay queued'); return; }
    for (const { session_id: id } of db.prepare('SELECT session_id FROM companion_session_cleanup').all() as { session_id: string }[]) {
      try { await getSessionManager().cleanupDeletedSession(id); db.prepare('DELETE FROM companion_session_cleanup WHERE session_id = ?').run(id); }
      catch (error) {
        // Retain the cleanup job across Host restarts; the deletion receipt stays committed.
        // Silence would hide a row that retries on every boot and never succeeds.
        logger.warn('Companion deleted-session cleanup failed, will retry next boot', { sessionId: id, error });
      }
    }
  }

  private model(provider: string, model: string) {
    const found = buildRuntimeModelOptions(getConfigService().getSettings()).find(m => m.provider === provider && m.model === model);
    if (!found) throw new Error('COMPANION_MODEL_UNAVAILABLE');
    return found;
  }
}
