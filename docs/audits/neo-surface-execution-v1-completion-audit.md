# Neo Surface Execution V1 completion audit

> Truth source: `docs/plans/2026-07-20-surface-execution-browser-computer-use.md`  
> Worktree: `/Users/linchen/.codex/worktrees/aedb/code-agent`  
> Baseline captured: 2026-07-21 Asia/Shanghai  
> Opening baseline: `ec7b06cfaaa4a3ed4f4928c02949121070d3e69f`  
> Current `origin/main`: `cb3ac0f74b66acf4af6616b9d4d93611f7f69990`  
> Current `HEAD`: `cb3ac0f74b66acf4af6616b9d4d93611f7f69990`  
> Current `merge-base(HEAD, origin/main)`: `cb3ac0f74b66acf4af6616b9d4d93611f7f69990`

This is a living implementation audit. A row becomes `verified` only after the
new implementation is connected to a real Browser/Computer path and the named
evidence has been produced from the current build.

## Baseline evidence

- `git fetch origin`: passed.
- Upstream advanced twice during audit. The first change only touched two game
  smoke files; the second calibrated ESLint and unrelated existing files.
  Both `git merge --ff-only origin/main` operations preserved the Surface diff
  and realigned HEAD/merge-base, most recently to `cb3ac0f74...`.
- `cmp` between the main-checkout plan source and this worktree copy: exact.
- Initial focused Vitest: 6 files, 76 tests passed.
- Initial typecheck: passed.
- Initial lint: exit 0 with 954 pre-existing warnings and no errors.
- Initial `git diff --check`: passed.
- P0-A/P0-B control-plane slice after the second rebase: 5 files, 20 tests
  passed; typecheck, focused lint and `git diff --check` passed.
- The isolated worktree had no `node_modules`; validation temporarily uses a
  read-only symlink to `/Users/linchen/Downloads/ai/code-agent/node_modules`.
  The symlink is tooling only and must be removed before closeout.

## Dependency graph

```text
P0-A Surface contract + strict capability registry + legacy projection
  -> P0-B owner session + grant + observation + operation queue + interrupt
       -> P0-C Relay protocol v2 + tab lease + element refs + real input
       -> Computer adapter owner/state/input-lock cleanup
  -> P0-D one renderer projection + semantic timeline + evidence + controls

P0-B + P0-C + P0-D
  -> P0-E protocol red lines + real Browser/Computer/WorkBuddy acceptance
  -> P1 frame/input/artifact/concurrency/recovery/cross-surface
  -> P2 external adapters/enterprise policy/provider API and benchmark gates
```

## P0 matrix

| Plan item | Baseline conclusion | Current implementation/evidence required |
|---|---|---|
| P0-A Surface V1 discriminated contract | in progress | Contract, strict parser, redaction and tests added; must enter live Browser and Computer paths. |
| Stateful CUA result semantics reused | partial baseline | Existing `delivery/verification/overall/successorState` is reusable; Surface adapter still required. |
| Host-enforced capability registry | in progress | Strict registry added; tool/provider preflight must call it. |
| Legacy message/replay/export compatibility | partial baseline | Existing proof replay/export remains readable; dual-read Surface projection and regression evidence required. |
| P0-B owner session | missing at baseline | Existing Browser/Relay/Computer state is process-, agent-, or conversation-scoped, not owner triple scoped. |
| Grant lifecycle | missing at baseline | Existing approvals do not bind session/run/agent + target + action + expiry. |
| Observation lifecycle | missing at baseline | Managed target refs lack provider generation/document revision; CUA state lacks run/agent owner. |
| Abortable operation queue | missing at baseline | Browser ignores AbortSignal; legacy Computer lock waiters cannot be aborted. |
| pause/takeover/stop/end_session | missing at baseline | Existing controls do not release provider input and stop future mutations under one state machine. |
| Successor observation and verification | partial baseline | Stateful CUA has it; Managed/Relay/legacy Computer do not share it. |
| Structured recovery | partial baseline | Several provider-specific recoveries exist; no stable Surface error contract in live paths. |
| P0-C Relay session + Agent Window | missing/unsafe | Relay is a global singleton socket with no owner/session window. |
| Tab borrow/return lease | missing/unsafe | Agent can enumerate all tabs and arbitrary `tabId` causes attach. |
| AX/backend node ref + real input | missing | Relay uses selector hints, JS click and direct value assignment. |
| Protocol handshake/capability/cancel/errors | missing | Wire message is only `id/method/params`; timeout cannot cancel dispatched mutation. |
| Host + extension permission checks | missing/unsafe | Neither side checks owner/grant/domain/action/expiry. |
| Token tightening | missing/unsafe | Fixed token is returned by unauthenticated local config and shared Renderer state. |
| Blocking human takeover | display-only baseline | Text classification exists, no blocking protocol or input release. |
| Cleanup/tab return | missing/unsafe | Detach failures are swallowed; original window/index is never recorded. |
| P0-D Surface card/header/timeline | missing | No live Surface renderer consumer. |
| Unified Evidence Card states | missing | Existing card has observed/not-observed/manual-takeover, not captured/analyzed/verified. |
| Outputs/Evidence/Sources | partial baseline | Outputs/Sources exist; live Surface Evidence does not. |
| Permission/Takeover/Recovery cards | partial baseline | Generic cards exist; no Surface identity/grant lifecycle. |
| Folded turn keeps key evidence/output | missing | Current `TurnCard` hides middle nodes and outputs when folded. |
| Sidebar/Conversation/Composer/PiP one state source | missing | They currently consume separate task/app/runtime/raw event sources. |
| P0-E unauthorized read/write rejection | missing | No protocol lease/grant red-line test. |
| Cross-agent/session isolation | partial baseline | BrowserPool separates named agents only; Relay is global; CUA state is session-only. |
| Stop p95 and no post-stop mutation | missing | Generic tool cancel does not prove Browser/Computer delivery stop. |
| Tab/lock cleanup | missing | No borrow return/recovery-required lifecycle. |
| Full-chain redaction canary | missing | Existing tests sanitize constructed objects, not every persistence/export boundary. |
| Managed/Relay real login tasks | deferred in old ADR evidence | Must run on current build with explicit authorization/test account. |
| Computer observe/mutate/verify/takeover | missing as one journey | Separate native smoke exists only. |
| WorkBuddy full loop | missing | Existing dogfoods use mock vision or synthetic data. |

## P1 matrix

| Plan item | Baseline conclusion |
|---|---|
| iframe/OOPIF/Shadow DOM/hover/drag/clipboard/dialog | missing from public reliable path |
| Relay console/network cursor | missing |
| Relay screenshot artifact + upload/download parity | missing |
| Router by capability/target/domain/ownership/intent | partial but unsafe; attached tab alone currently selects Relay |
| Computer fallback/input lock under Surface events | partial provider base, missing integration |
| Three concurrent Surface Sessions | missing |
| Browser/Computer automatic switch with reason | missing |
| Signed extension/pairing/doctor/upgrade/protocol compatibility | partial packaging, missing runtime proof |
| Screenshot before/after/checklist/retry | partial artifact base, missing Surface evidence |
| One SurfaceProofService | missing |
| Durable read-only checkpoint/recovery | generic run base only |

## P2 matrix

| Plan item | Baseline conclusion / decision gate |
|---|---|
| External `neo surface` / `neo browser` adapter | missing |
| Multi-account and organization policy/audit/retention | partial profile base; policy surface missing |
| Replayable proof and failure reproduction | partial proof timeline; action replay missing |
| Windows/Linux providers and profile import | missing as Surface providers/E2E |
| Multi-browser/remote/mobile/in-app provider API | missing |
| Remote pool/device-cloud investment | evidence-backed decision requires real usage and benchmark produced by P0/P1 |

## Existing assets to preserve

- Durable Run `runId`, owner fencing and operation ledger from ADR-037.
- ADR-041 Managed/Relay dual-engine names, profile isolation, proof and redaction.
- ADR-043 tool-step three-state behavior and failure expansion semantics.
- Stateful CUA state-bound mutation and delivery/verification split.
- Existing tool names, old messages, replay, session export and release gates.

## Immediate implementation order

1. Finish P0-A by attaching Surface projection and proof to real results.
2. Build owner-triple Session/Grant/Observation stores and abortable operation queue.
3. Wrap Stateful CUA, then legacy Computer, then Managed Browser.
4. Replace Relay trust boundary with protocol v2 and a tab lease.
5. Add one renderer Surface projection and conversation components.
6. Run protocol red lines before any real-site dogfood.

## External evidence constraints

- A real logged-in Relay acceptance needs an explicitly authorized tab and may
  need a user/test account. MFA/CAPTCHA must enter blocking takeover.
- System TCC permissions may be required for real Computer mutation.
- These conditions do not block contract/control-plane implementation or
  controlled Browser/Computer E2E; they only bound the final live sign-off.
