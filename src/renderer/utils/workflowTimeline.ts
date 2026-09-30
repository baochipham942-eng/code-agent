// ============================================================================
// Workflow timeline — pure roster projection of a ScriptRunSnapshot.
// Phase order matches the old inline groupByPhase: declared phases first,
// then undeclared phases in first-seen order, then agents with no phase.
// ============================================================================

import type { ScriptRunAgentSnapshot, ScriptRunAgentStatus, ScriptRunSnapshot } from '@shared/contract/scriptRun';

/** Bucket key for agents whose snapshot has no phase. Header stays hidden. */
export const WORKFLOW_TIMELINE_NO_PHASE = '__no_phase__';

/** At or below this size a phase shows every agent. Above it, the roster folds. */
const ROSTER_FOLD_THRESHOLD = 6;
const ROSTER_PIN_COUNT = 5;

interface PhaseCounts {
  running: number;
  done: number;
  error: number;
  queued: number;
  skipped: number;
}

interface WorkflowTimelinePhase {
  name: string;
  total: number;
  counts: PhaseCounts;
  pinned: ScriptRunAgentSnapshot[];
  hiddenCount: number;
}

interface WorkflowTimeline {
  phases: WorkflowTimelinePhase[];
  totals: {
    phaseCount: number;
    agentCount: number;
    running: number;
    done: number;
    error: number;
  };
}

interface RankedAgent {
  agent: ScriptRunAgentSnapshot;
  index: number;
  tier: number;
}

// ScriptRunAgentStatus has no asking state; pin tier is running, then error, then participant order.
function pinTier(status: ScriptRunAgentStatus): number {
  if (status === 'running') return 0;
  if (status === 'error') return 1;
  return 2;
}

function rankAgents(agents: ScriptRunAgentSnapshot[]): RankedAgent[] {
  return agents
    .map((agent, index) => ({ agent, index, tier: pinTier(agent.status) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index);
}

function countAgents(agents: ScriptRunAgentSnapshot[]): PhaseCounts {
  const counts: PhaseCounts = { running: 0, done: 0, error: 0, queued: 0, skipped: 0 };
  for (const agent of agents) counts[agent.status] += 1;
  return counts;
}

function groupByPhase(snapshot: ScriptRunSnapshot): Array<{ name: string; agents: ScriptRunAgentSnapshot[] }> {
  const buckets = new Map<string, ScriptRunAgentSnapshot[]>();
  for (const agent of snapshot.agents) {
    const key = agent.phase ?? WORKFLOW_TIMELINE_NO_PHASE;
    const list = buckets.get(key);
    if (list) list.push(agent);
    else buckets.set(key, [agent]);
  }

  const ordered: Array<{ name: string; agents: ScriptRunAgentSnapshot[] }> = [];
  const seen = new Set<string>();
  for (const phase of snapshot.phases) {
    if (seen.has(phase)) continue;
    const agents = buckets.get(phase);
    if (!agents) continue;
    ordered.push({ name: phase, agents });
    seen.add(phase);
  }
  for (const [name, agents] of buckets) {
    if (seen.has(name) || name === WORKFLOW_TIMELINE_NO_PHASE) continue;
    ordered.push({ name, agents });
  }
  const noPhase = buckets.get(WORKFLOW_TIMELINE_NO_PHASE);
  if (noPhase && !seen.has(WORKFLOW_TIMELINE_NO_PHASE)) {
    ordered.push({ name: WORKFLOW_TIMELINE_NO_PHASE, agents: noPhase });
  }
  return ordered;
}

function isLowerPriority(candidate: RankedAgent, current: RankedAgent): boolean {
  return candidate.tier > current.tier || (candidate.tier === current.tier && candidate.index > current.index);
}

function selectPins(
  agents: ScriptRunAgentSnapshot[],
  prevIds: string[] | undefined,
): ScriptRunAgentSnapshot[] {
  if (agents.length <= ROSTER_FOLD_THRESHOLD) return agents.slice();

  const ranked = rankAgents(agents);
  const ideal = ranked.slice(0, ROSTER_PIN_COUNT).map((row) => row.agent);
  if (!prevIds || prevIds.length === 0) return ideal;

  const byId = new Map(ranked.map((row) => [row.agent.id, row]));
  const kept: ScriptRunAgentSnapshot[] = [];
  const keptIds = new Set<string>();
  for (const id of prevIds) {
    const row = byId.get(id);
    if (!row || keptIds.has(id)) continue;
    kept.push(row.agent);
    keptIds.add(id);
    if (kept.length === ROSTER_PIN_COUNT) break;
  }

  if (kept.length < ROSTER_PIN_COUNT) {
    for (const agent of ideal) {
      if (kept.length === ROSTER_PIN_COUNT) break;
      if (keptIds.has(agent.id)) continue;
      kept.push(agent);
      keptIds.add(agent.id);
    }
    return kept;
  }

  const idealIds = new Set(ideal.map((agent) => agent.id));
  let outgoing = -1;
  let outgoingRow: RankedAgent | undefined;
  for (let index = 0; index < kept.length; index += 1) {
    const row = byId.get(kept[index].id);
    if (!row || idealIds.has(row.agent.id)) continue;
    if (!outgoingRow || isLowerPriority(row, outgoingRow)) {
      outgoing = index;
      outgoingRow = row;
    }
  }
  if (outgoing === -1) return kept;

  const incoming = ideal.find((agent) => !keptIds.has(agent.id));
  if (!incoming) return kept;
  const next = kept.slice();
  next[outgoing] = incoming;
  return next;
}

export function buildWorkflowTimeline(
  snapshot: ScriptRunSnapshot,
  prevPins?: Record<string, string[]>,
): WorkflowTimeline {
  const phases = groupByPhase(snapshot).map(({ name, agents }) => {
    const pinned = selectPins(agents, prevPins?.[name]);
    const folded = agents.length > ROSTER_FOLD_THRESHOLD;
    return {
      name,
      total: agents.length,
      counts: countAgents(agents),
      pinned,
      hiddenCount: folded ? agents.length - ROSTER_PIN_COUNT : 0,
    };
  });

  const totals = {
    phaseCount: phases.length,
    agentCount: 0,
    running: 0,
    done: 0,
    error: 0,
  };
  for (const phase of phases) {
    totals.agentCount += phase.total;
    totals.running += phase.counts.running;
    totals.done += phase.counts.done;
    totals.error += phase.counts.error;
  }
  return { phases, totals };
}
