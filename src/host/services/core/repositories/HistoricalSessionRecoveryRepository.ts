import type BetterSqlite3 from 'better-sqlite3';
import type { HistoricalSessionRecoveryRequest, HistoricalSessionRecoveryResult } from '../../../../shared/contract/historicalSessionRecovery';
import { TERMINAL_RUN_STATUSES } from '../../../../shared/contract/durableRun';
import { canonicalConversationJson, conversationSha256 } from '../database/schemaConversationBranch';
import { ConversationBranchAuditRepository } from './ConversationBranchAuditRepository';
import { ConversationBranchLedgerStore } from './ConversationBranchLedgerStore';
import { ConversationBranchRepository } from './ConversationBranchRepository';
import { SessionRepository } from './SessionRepository';
import { SessionForkRepository } from './SessionForkRepository';
import { rowToMessage } from './sessionRepositoryParsers';

type Row = Record<string, unknown>;
const digest = (value: unknown): string => conversationSha256(canonicalConversationJson(value));
class RecoveryRejected extends Error {
  constructor(readonly code: string) { super(code); }
}
function requireEvidence(condition: unknown, code: string): asserts condition {
  if (!condition) throw new RecoveryRejected(code);
}

/** Trusted host callers supply the authenticated actor; renderer payloads cannot select it. */
export class HistoricalSessionRecoveryRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  recover(actorUserId: string | null, request: HistoricalSessionRecoveryRequest, now = Date.now()): HistoricalSessionRecoveryResult {
    let historyReadable = false;
    try {
      requireEvidence(typeof actorUserId === 'string' && actorUserId.trim(), 'AUTH_REQUIRED');
      requireEvidence(request && typeof request.sessionId === 'string'
        && (request.projectId === null || typeof request.projectId === 'string')
        && ['inspect', 'import'].includes(request.action), 'INVALID_REQUEST');
      // Both inspect and import see a single snapshot. Import obtains its write lock
      // before revalidation, preventing a plan/apply TOCTOU window.
      const execute = () => {
        const requested = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(request.sessionId) as Row | undefined;
        requireEvidence(requested?.user_id === actorUserId && !requested.is_deleted, 'SESSION_ACCESS_DENIED');
        requireEvidence(requested.project_id === request.projectId, 'PROJECT_MISMATCH');
        historyReadable = true;
        const snapshot = this.inspectSource(actorUserId, request.sessionId, request.projectId);
        const sourceDigest = digest(snapshot);
        const recoveryId = `history_recovery_${digest({ actorUserId, projectId: request.projectId, root: snapshot.root.session_id }).slice(0, 32)}`;
        const sessionMap = Object.fromEntries(snapshot.branches.map((branch) => [String(branch.session_id),
          `session_recovered_${digest({ recoveryId, source: branch.session_id }).slice(0, 32)}`]));
        const sessions = snapshot.branches.map((branch) => ({
          sourceSessionId: String(branch.session_id), targetSessionId: sessionMap[String(branch.session_id)],
          parentSourceSessionId: branch.parent_branch_id === null ? null
            : String(snapshot.branches.find((parent) => parent.id === branch.parent_branch_id)!.session_id),
          messages: snapshot.messages.filter((message) => message.session_id === branch.session_id).length,
        }));
        const changes = { sessions: sessions.length, messages: snapshot.messages.length,
          branches: snapshot.branches.length, entries: snapshot.entries.length, references: snapshot.references.length,
          events: snapshot.events.length, forks: snapshot.branches.length - 1,
          forkMessageMappings: snapshot.references.filter((ref) => ref.alias_kind === 'fork_copy').length, receipts: 1, schemaObjects: 0 };
        const base = { historyReadable: true, sourceContinuable: false as const,
          continuation: 'normal_authorization_required' as const, sourceDigest, recoveryId, sessions, changes };
        const receiptTable = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='historical_session_recoveries'").get();
        const receipt = receiptTable ? this.db.prepare('SELECT * FROM historical_session_recoveries WHERE id = ?').get(recoveryId) as Row | undefined : undefined;
        if (receipt) {
          requireEvidence(receipt.source_digest === sourceDigest && receipt.actor_user_id === actorUserId, 'SOURCE_CHANGED_AFTER_IMPORT');
          this.auditTargets(actorUserId, request.projectId, sessionMap);
          const idle = Object.values(sessionMap).every((id) => {
            const target = this.db.prepare('SELECT status, read_only FROM sessions WHERE id = ?').get(id) as Row;
            return !target.read_only && !['running', 'queued', 'paused', 'cancelling'].includes(String(target.status))
              && !this.hasUnfinishedRun(id);
          });
          return { ...base, changes: { sessions: 0, messages: 0, branches: 0, entries: 0, references: 0, events: 0,
            forks: 0, forkMessageMappings: 0, receipts: 0, schemaObjects: 0 }, status: 'already_imported' as const,
          code: idle ? 'ALREADY_IMPORTED' : 'TARGET_NOT_IDLE', targetContinuable: idle };
        }
        changes.schemaObjects = receiptTable ? 0 : 3;
        for (const target of Object.values(sessionMap)) {
          requireEvidence(!this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(target), 'TARGET_COLLISION');
        }
        if (request.action === 'inspect') return { ...base, status: 'ready' as const, code: 'IMPORT_REQUIRED', targetContinuable: false };
        requireEvidence(request.expectedDigest === sourceDigest, 'STALE_PLAN');
        const mappings = this.importGraph(actorUserId, request.projectId, recoveryId, snapshot, sessionMap, now);
        this.auditTargets(actorUserId, request.projectId, sessionMap);
        // Created only inside the successful import transaction, never during dry-run
        // or ordinary database startup. Source ledger triggers remain intact.
        this.db.exec(`CREATE TABLE IF NOT EXISTS historical_session_recoveries (
          id TEXT PRIMARY KEY, actor_user_id TEXT NOT NULL, source_digest TEXT NOT NULL,
          manifest_json TEXT NOT NULL, created_at INTEGER NOT NULL);
          CREATE TRIGGER IF NOT EXISTS historical_session_recoveries_immutable_update
          BEFORE UPDATE ON historical_session_recoveries BEGIN SELECT RAISE(ABORT, 'immutable recovery receipt'); END;
          CREATE TRIGGER IF NOT EXISTS historical_session_recoveries_immutable_delete
          BEFORE DELETE ON historical_session_recoveries BEGIN SELECT RAISE(ABORT, 'immutable recovery receipt'); END;`);
        this.db.prepare('INSERT INTO historical_session_recoveries VALUES (?, ?, ?, ?, ?)').run(
          recoveryId, actorUserId, sourceDigest, canonicalConversationJson({ version: 1, projectId: request.projectId,
            sourceOwnerUserId: null, targetOwnerUserId: actorUserId, sessions, mappings,
            evidence: ['explicit_session_owner', 'exact_project', 'local_cli_ledger', 'healthy_lineage_and_projection', 'closed_branch_graph'],
            sourceBranches: snapshot.branches, sourceEntries: snapshot.entries.map((entry) => ({ id: entry.id, payloadDigest: entry.payload_digest, sourceSessionId: entry.source_session_id, sourceMessageId: entry.source_message_id })),
            sourceEvents: snapshot.events.map((event) => ({ id: event.id, digest: event.event_digest })),
          }), now);
        return { ...base, status: 'imported' as const, code: 'IMPORTED', targetContinuable: true };
      };
      return request.action === 'import' ? this.db.transaction(execute).immediate() : this.db.transaction(execute)();
    } catch (error) {
      return { status: 'rejected', code: error instanceof RecoveryRejected ? error.code
        : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'RECOVERY_FAILED',
      historyReadable, sourceContinuable: false, targetContinuable: false };
    }
  }

  private inspectSource(actorUserId: string, sessionId: string, projectId: string | null) {
    const branch = this.db.prepare('SELECT * FROM conversation_branches WHERE session_id = ?').get(sessionId) as Row | undefined;
    requireEvidence(branch, 'BRANCH_MISSING');
    const branches = this.db.prepare('SELECT * FROM conversation_branches WHERE root_branch_id = ? ORDER BY created_at, id').all(branch.root_branch_id) as Row[];
    const root = branches.find((item) => item.id === branch.root_branch_id);
    requireEvidence(root?.parent_branch_id === null && /^cli_session_\d+_[a-z0-9]+$/.test(String(root.session_id)), 'CLI_SOURCE_EVIDENCE_REQUIRED');
    const sessions: Row[] = [], messages: Row[] = [], references: Row[] = [], events: Row[] = [], sourceForks: Row[] = [], sourceForkMappings: Row[] = [];
    const entries = new Map<string, Row>();
    const audit = new ConversationBranchAuditRepository(this.db, new ConversationBranchLedgerStore(this.db));
    for (const item of branches) {
      const session = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(item.session_id) as Row | undefined;
      requireEvidence(session?.user_id === actorUserId && !session.is_deleted, 'GRAPH_OWNER_MISMATCH');
      requireEvidence(session.project_id === projectId && item.project_id === projectId, 'GRAPH_PROJECT_MISMATCH');
      requireEvidence(item.owner_user_id === null, 'SOURCE_ALREADY_OWNED');
      requireEvidence(typeof session.working_directory === 'string' && session.working_directory.length > 0, 'WORKSPACE_EVIDENCE_REQUIRED');
      requireEvidence(!session.read_only && !['running', 'queued', 'paused', 'cancelling'].includes(String(session.status)), 'SOURCE_NOT_IDLE');
      requireEvidence(!session.agent_engine || JSON.parse(String(session.agent_engine)).kind === 'native', 'UNSUPPORTED_ENGINE');
      requireEvidence(!this.hasUnfinishedRun(String(item.session_id)), 'SOURCE_RUN_ACTIVE');
      const children = this.db.prepare('SELECT * FROM conversation_branches WHERE parent_branch_id = ?').all(item.id) as Row[];
      requireEvidence(children.every((child) => branches.some((candidate) => candidate.id === child.id)), 'GRAPH_NOT_CLOSED');
      const childSessions = this.db.prepare('SELECT id FROM sessions WHERE parent_session_id = ? AND COALESCE(is_deleted, 0) = 0').all(item.session_id) as Row[];
      requireEvidence(childSessions.every((child) => branches.some((candidate) => candidate.session_id === child.id)), 'GRAPH_NOT_CLOSED');
      const forkRows = this.db.prepare('SELECT * FROM session_forks WHERE source_session_id = ? OR child_session_id = ?').all(item.session_id, item.session_id) as Row[];
      requireEvidence(forkRows.every((fork) => branches.some((candidate) => candidate.session_id === fork.child_session_id
        && candidate.fork_id === fork.id) && branches.some((candidate) => candidate.session_id === fork.source_session_id)), 'FORK_GRAPH_CONFLICT');
      if (item.parent_branch_id === null) {
        requireEvidence(session.parent_session_id == null, 'SESSION_PARENT_CONFLICT');
      } else {
        const parent = branches.find((candidate) => candidate.id === item.parent_branch_id);
        const fork = forkRows.find((candidate) => candidate.id === item.fork_id);
        requireEvidence(parent && session.parent_session_id === parent.session_id && fork
          && fork.source_session_id === parent.session_id && fork.child_session_id === item.session_id
          && fork.root_session_id === root.session_id && fork.status === 'completed'
          && fork.workspace_mode === 'shared_current' && fork.context_delivery_mode === 'neo_native_prefix', 'FORK_EVIDENCE_REQUIRED');
        sourceForks.push(fork);
        const mappings = this.db.prepare('SELECT * FROM session_fork_message_map WHERE fork_id = ? ORDER BY ordinal').all(fork.id) as Row[];
        sourceForkMappings.push(...mappings);
        // Reuse the production prefix/digest/order validation as additional evidence.
        const context = new SessionForkRepository(this.db).getContextSource(String(item.session_id));
        const forkRefs = this.db.prepare("SELECT * FROM conversation_branch_entries WHERE branch_id = ? AND alias_kind = 'fork_copy' ORDER BY ordinal").all(item.id) as Row[];
        requireEvidence(context?.mappedActivePrefix.length === mappings.length && mappings.length === forkRefs.length
          && mappings.every((mapping, index) => mapping.child_message_id === forkRefs[index].projected_message_id)
          && forkRefs.at(-1)?.entry_id === item.anchor_entry_id, 'FORK_PREFIX_MISMATCH');
      }
      const sourceAudit = audit.auditHistoricalImportSource(String(item.session_id), { ownerUserId: actorUserId, projectId });
      requireEvidence(sourceAudit.status === 'healthy' && sourceAudit.issues.length === 0, 'SOURCE_LEDGER_INVALID');
      const rows = this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp, rowid').all(item.session_id) as Row[];
      requireEvidence(rows.length > 0 && rows.every((row) => (row.visibility ?? 'active') === 'active'
        && (row.author_user_id == null || row.author_user_id === actorUserId)), 'MESSAGE_AUTHOR_OR_VISIBILITY_CONFLICT');
      const refs = this.db.prepare('SELECT * FROM conversation_branch_entries WHERE branch_id = ? ORDER BY ordinal').all(item.id) as Row[];
      const stream = this.db.prepare('SELECT * FROM conversation_branch_events WHERE branch_id = ? ORDER BY sequence').all(item.id) as Row[];
      requireEvidence(stream.length > 0 && stream.every((event) => event.actor_user_id === null
        && ['append', 'fork'].includes(String(event.event_type))), 'UNSUPPORTED_SOURCE_HISTORY');
      for (const ref of refs) {
        const entry = this.db.prepare('SELECT * FROM conversation_entries WHERE id = ?').get(ref.entry_id) as Row | undefined;
        requireEvidence(entry?.owner_user_id === null && entry.project_id === projectId, 'ENTRY_BOUNDARY_MISMATCH');
        requireEvidence(branches.some((candidate) => candidate.session_id === entry.source_session_id), 'ENTRY_SOURCE_NOT_CLOSED');
        const consumers = this.db.prepare('SELECT branch_id FROM conversation_branch_entries WHERE entry_id = ?').all(entry.id) as Row[];
        requireEvidence(consumers.every((consumer) => branches.some((candidate) => candidate.id === consumer.branch_id)), 'ENTRY_SHARED_OUTSIDE_GRAPH');
        const provenance = JSON.parse(String(entry.provenance_json));
        requireEvidence(provenance.kind === 'compatibility_projection_append' && provenance.syncOrigin === 'local', 'LOCAL_LEDGER_EVIDENCE_REQUIRED');
        entries.set(String(entry.id), entry);
      }
      sessions.push(session); messages.push(...rows); references.push(...refs); events.push(...stream);
    }
    requireEvidence(sessions.every((session) => session.working_directory === sessions[0].working_directory), 'WORKSPACE_MISMATCH');
    if (projectId !== null) {
      const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Row | undefined;
      requireEvidence(project && !project.is_deleted && project.status === 'active', 'PROJECT_UNAVAILABLE');
    }
    // Include the entire root closure: a request for a child never silently drops its ancestors.
    const ordered: Row[] = [], pending = [...branches];
    while (pending.length) {
      const index = pending.findIndex((item) => item.parent_branch_id === null || ordered.some((parent) => parent.id === item.parent_branch_id));
      requireEvidence(index >= 0, 'GRAPH_NOT_CLOSED');
      ordered.push(pending.splice(index, 1)[0]);
    }
    return { root, branches: ordered, sessions, messages, references, entries: [...entries.values()], events, sourceForks, sourceForkMappings };
  }

  private importGraph(actor: string, projectId: string | null, recoveryId: string,
    snapshot: ReturnType<HistoricalSessionRecoveryRepository['inspectSource']>, sessionMap: Record<string, string>, now: number) {
    const ledger = new ConversationBranchRepository(this.db), sessions = new SessionRepository(this.db);
    const forks = new SessionForkRepository(this.db, ledger);
    const messageMap: Record<string, string> = {}, forkMap: Record<string, string> = {};
    for (const branch of snapshot.branches) {
      const sourceId = String(branch.session_id), targetId = sessionMap[sourceId];
      const source = snapshot.sessions.find((row) => row.id === sourceId)!;
      const refs = snapshot.references.filter((row) => row.branch_id === branch.id);
      const copies = refs.filter((ref) => ref.alias_kind === 'fork_copy');
      if (branch.parent_branch_id !== null) {
        const parent = snapshot.branches.find((row) => row.id === branch.parent_branch_id)!;
        const anchor = snapshot.references.find((ref) => ref.branch_id === parent.id && ref.entry_id === branch.anchor_entry_id);
        requireEvidence(anchor && copies.length > 0, 'FORK_EVIDENCE_REQUIRED');
        const forkId = `fork_recovered_${digest({ recoveryId, source: branch.fork_id }).slice(0, 32)}`;
        const result = forks.createFork({ sourceSessionId: sessionMap[String(parent.session_id)],
          anchorAssistantMessageId: messageMap[String(anchor.projected_message_id)], ownerUserId: actor,
          idempotencyKey: `${recoveryId}:${forkId}`, forkId, childSessionId: targetId, childTitle: String(source.title),
          workspaceMode: 'shared_current', contextDeliveryMode: 'neo_native_prefix', now });
        forkMap[String(branch.fork_id)] = forkId;
        requireEvidence(result.messageMappings.length === copies.length, 'FORK_PREFIX_MISMATCH');
        copies.forEach((ref, index) => { messageMap[String(ref.projected_message_id)] = result.messageMappings[index].childMessageId; });
      } else {
        // Deliberately omit persisted execution handles, approvals, workspace grants,
        // task IDs and runtime metadata; continuation goes through normal permissions.
        sessions.createSession({ id: targetId, userId: actor, projectId: projectId ?? undefined,
          title: String(source.title), modelConfig: { provider: source.model_provider, model: source.model_name },
          workingDirectory: source.working_directory, createdAt: now, updatedAt: now,
          engine: { kind: 'native', permissionProfile: 'read_only', origin: 'manual' },
          metadata: { historicalRecovery: { recoveryId, sourceSessionId: sourceId } },
        } as Parameters<SessionRepository['createSession']>[0]);
        ledger.initializeSessionBranch({ sessionId: targetId, boundary: { ownerUserId: actor, projectId }, createdAt: now });
      }
      for (const ref of refs.filter((row) => row.alias_kind !== 'fork_copy')) {
        const sourceMessageId = String(ref.projected_message_id);
        const row = snapshot.messages.find((message) => message.id === sourceMessageId)!;
        const targetMessageId = `msg_recovered_${digest({ recoveryId, sourceMessageId }).slice(0, 32)}`;
        messageMap[sourceMessageId] = targetMessageId;
        sessions.addMessage(targetId, { ...rowToMessage(row), id: targetMessageId }, {
          updatedAt: now, provenanceKind: 'historical_cli_import',
        });
      }
      const target = this.db.prepare('SELECT metadata FROM sessions WHERE id = ?').get(targetId) as Row;
      this.db.prepare('UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?').run(
        canonicalConversationJson({ ...JSON.parse(String(target.metadata ?? '{}')),
          historicalRecovery: { recoveryId, sourceSessionId: sourceId } }), now, targetId);
    }
    return { sessionMap, messageMap, forkMap };
  }

  private auditTargets(actor: string, projectId: string | null, sessionMap: Record<string, string>) {
    const ledger = new ConversationBranchRepository(this.db);
    for (const targetId of Object.values(sessionMap)) {
      const audit = ledger.auditLineage(targetId, { ownerUserId: actor, projectId });
      requireEvidence(audit.status === 'healthy' && audit.issues.length === 0, 'TARGET_LEDGER_INVALID');
      ledger.replay(targetId, { ownerUserId: actor, projectId });
    }
  }

  private hasUnfinishedRun(sessionId: string): boolean {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='durable_runs'").get()) return false;
    const runs = this.db.prepare('SELECT status FROM durable_runs WHERE session_id = ?').all(sessionId) as Row[];
    return runs.some((run) => !(TERMINAL_RUN_STATUSES as readonly string[]).includes(String(run.status)));
  }
}
