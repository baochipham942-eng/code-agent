// ============================================================================
// P3: Trajectory Analysis Module - Barrel Export
// ============================================================================

export { TrajectoryBuilder } from './trajectoryBuilder';
export { DeviationDetector } from './deviationDetector';
export { evaluateAgentTrajectoryReplay } from './trajectoryGate';
export {
  buildAgentTrajectoryFromReplay,
  exportAgentTrajectories,
  listTelemetryTrajectorySessionIds,
  normalizeAgentTrajectorySampleWindow,
  shouldExportTrajectory,
  writeAgentTrajectoryJsonl,
} from './trajectoryExporter';
export * from './attribution';
