// ============================================================================
// Scheduler Module - Task DAG and Parallel Scheduling
// Session 4: Task DAG + Parallel Scheduling
// ============================================================================

// Core DAG
export { TaskDAG } from './TaskDAG';

// Only expose the scheduler surface consumed through this barrel. Other
// scheduler internals stay available from their defining modules.
export {
  createRunDAGScheduler,
  getDAGScheduler,
  type SchedulerResult,
} from './DAGScheduler';
export { initDAGEventBridge } from './dagEventBridge';
