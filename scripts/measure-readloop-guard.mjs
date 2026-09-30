#!/usr/bin/env node
/**
 * Replay read/write rounds against the pre-change per-call guard.
 * Patrol session exports were not present in this worktree, so the session
 * sequences below combine the existing unit-test shapes with synthetic rounds
 * modelled on FB-275's reported parallel-call counts.
 */

const CURRENT_CALL_GUARD = 15;
const sessions = [
  { name: 'unit-sequential-15', rounds: Array.from({ length: 15 }, () => ({ reads: 1 })) },
  { name: 'unit-parallel-3x5', rounds: Array.from({ length: 3 }, () => ({ reads: 5 })) },
  { name: 'synthetic-parallel-8x5', rounds: Array.from({ length: 5 }, () => ({ reads: 8 })) },
  { name: 'synthetic-mixed-write-reset', rounds: [
    { reads: 4 }, { reads: 4 }, { reads: 2, write: true },
    { reads: 8 }, { reads: 8 }, { reads: 8 },
  ] },
  { name: 'synthetic-sequential-after-write', rounds: [
    { reads: 1 }, { reads: 1 }, { reads: 1 }, { reads: 1 }, { reads: 1 },
    { reads: 1, write: true },
    ...Array.from({ length: 15 }, () => ({ reads: 1 })),
  ] },
  { name: 'synthetic-parallel-heavy-62pct', rounds: [
    { reads: 5 }, { reads: 5 }, { reads: 5 }, { reads: 2 },
    { reads: 8 }, { reads: 8 }, { reads: 8 }, { reads: 8 }, { reads: 8 },
  ] },
];

function replay(session) {
  let calls = 0;
  let rounds = 0;
  let readSinceWrite = 0;
  for (let index = 0; index < session.rounds.length; index += 1) {
    const round = session.rounds[index];
    if (round.reads > 0) {
      rounds += 1;
      for (let call = 0; call < round.reads; call += 1) {
        calls += 1;
        readSinceWrite += 1;
        if (calls >= CURRENT_CALL_GUARD) {
          return { guardRound: rounds, guardCalls: calls, sourceRound: index + 1 };
        }
      }
    }
    if (round.write) {
      calls = 0;
      rounds = 0;
      readSinceWrite = 0;
    }
  }
  return { guardRound: null, guardCalls: calls, sourceRound: null };
}

console.log('source=unit-test-shapes+synthetic; current_guard=15_consecutive_read_only_calls');
console.log('session | consecutive_read_only_rounds_at_guard | consecutive_read_only_calls_at_guard');
for (const session of sessions) {
  const result = replay(session);
  console.log(`${session.name} | ${result.guardRound ?? 'none'} | ${result.guardCalls}${result.sourceRound ? ` (source round ${result.sourceRound})` : ''}`);
}
console.log('chosen_backstop=40 consecutive read-only calls');
console.log('reason=40 preserves three 8-call parallel rounds (24 calls) while bounding five such rounds at 40 calls, well before the 15-round limit; it is also above the observed 15-call legacy fire point.');
