# Historical CLI session recovery

An explicit session owner can coexist with an older ownerless immutable branch
when a local integration granted access by updating only `sessions.user_id`.
Reading that session does not authorize execution against its original ledger.

Recovery imports a new, owned conversation graph. It never updates the source
session, branch, entries, events or trace. Normal ownership enforcement stays in
place, including the original session's `OWNER_MISMATCH` on execution.

## Host entry and GUI integration

The existing `domain:session` handler has an independent `recoverHistory` action.
Its shared request/result contract is `shared/contract/historicalSessionRecovery.ts`.
The host obtains the actor from `AuthService.hasVerifiedSession()` and
`getCurrentUser()`; a cached identity or a payload-supplied actor is insufficient.

1. Send `{action: 'inspect', sessionId, projectId}`. This reads one SQLite snapshot
   and returns `ready`, the source digest, deterministic destination session IDs,
   source relationships and proposed table counts. It creates no schema or rows.
2. Explain that the original remains saved history and a linked copy will become
   available for continuation under normal authorization. Display refusals by code.
3. On the user's import action, send `{action: 'import', sessionId, projectId,
   expectedDigest}`. The host takes an immediate transaction and rebuilds the plan
   from storage. A stale digest fails before any insertion.
4. On `imported` or `already_imported`, load the target corresponding to the
   originally selected source ID using the existing session load action. Normal
   engine, workspace and tool authorization still applies. Recovery grants no
   approval, does not answer historical questions, and does not restart a run.

`sourceContinuable` is always false. `targetContinuable` means the imported owner
and ledger are usable, with `continuation: normal_authorization_required`; it is
not a claim that a model call or the original business task has completed.
The result separates history access from import readiness. A rejected result
provides a stable code and never reports a successful target. Repeated imports
return the same target graph and zero new objects, after another target audit.

No renderer card, layout, trace producer, or historical presentation is changed.
The parallel GUI task can add translated labels and a button using this action.
There is intentionally no startup auto-migration or operator apply command.

## Accepted evidence and refusals

All sessions in the complete root graph must already grant the same verified
user access, match the exact project (including null versus non-null), have a
common nonempty workspace, and be idle and writable. A named project must exist
and be active. Every nonterminal durable run blocks import, including waiting
and unknown future states. No run is cancelled or approved during recovery.

The root must have a local CLI session identity. Every branch/entry must still
have a null owner in the exact project. Every native entry must carry persisted
`compatibility_projection_append` / `syncOrigin: local` provenance. Explicit
message authors must agree with the granted owner. Source identity, root,
ancestry, entry digests, event chains, aliases and public message projections
must pass the existing full audit. This is an import based on an existing access
grant plus local provenance, not a cryptographic assertion of who originally
operated an unauthenticated CLI.

This version accepts append-only histories and completed shared-workspace native
forks. It verifies both directions of parent edges, source session parent fields,
fork rows, anchor/prefix mappings and their digests. A child request includes the
whole root graph. Missing or cross-boundary evidence, quarantines, revisions,
rewinds, external engine handles and isolated workspace forks are refused; they
require an explicitly designed extension, not a lossy import.

For nested forks, compatibility maps point to the immediate parent's message
alias. The audit checks that alias against the same canonical entry and origin;
it does not incorrectly require the immediate alias to equal the original root
message ID.

## Transaction, provenance and rollback

New sessions, messages, branches, entries, references, events, fork rows and fork
message maps commit together with one immutable `historical_session_recoveries`
receipt per root graph. The receipt records actor, project, original null owner,
source graph digest, original branches/entry/event fingerprints and complete
source-to-target session/message/fork mappings. Target metadata links back to the
source and receipt; imported fork metadata retains its newly generated lineage.
Original IDs, message content and traces remain available at their source.

New native sessions use the read-only permission profile. Runtime metadata,
approval decisions, workspace grants, external resume IDs and source task IDs
are not inherited. No previous tool outcome is executed again by the importer.

Any failure, including final receipt insertion, rolls back all target writes and
schema additions. Success is retryable using the same deterministic recovery ID;
source changes after import or corrupted/deleted targets cause explicit refusal.

Before a separately authorized real import, stop writers and take a verified
SQLite backup including the current WAL state. A full rollback can restore that
backup only while no subsequent writes have been accepted. After continuation,
do not restore an old database over newer work or delete immutable records:
retain the audit receipt and use normal authorized archival for the imported
sessions, or design a separate revocation operation. No source owner field needs
to be undone because recovery never edits it.

## Reproduction and evidence limits

`npx tsx scripts/acceptance/historical-session-recovery-dry-run.ts DB ACTOR_ID WORKSPACE`
is an operator diagnostic with `readonly`, `fileMustExist` and `query_only` enabled.
The actor is supplied only for analysis; applying still requires verified host
authentication through the product action.

Unit coverage uses real SQLite, immutable triggers, cross-owner/project failures,
stale plans, repeated calls, sibling/grandchild graphs and injected SQLite faults.
The continuation fixture uses real `SessionManager.restoreSession`, native Read
on an isolated random-token file, persistence and fresh-manager replay. Its model
selection is deterministic; it does not claim GUI, AgentLoop or external-model
end-to-end coverage. Original data application and GUI integration require a
separate authorized follow-up.
