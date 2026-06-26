// ============================================================================
// Tool Execution Module - Exports
// ============================================================================

export {
  isParallelSafeTool,
  classifyToolCalls,
  getBatchSlices,
  executeInBatches,
  createParallelStrategy,
  DEFAULT_PARALLEL_CONFIG,
  type ParallelExecutionConfig,
} from './parallelStrategy';

export {
  CircuitBreaker,
  createCircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  type CircuitBreakerConfig,
} from './circuitBreaker';

export {
  buildToolExecutionDAG,
  executeWithDAG,
  type ToolNode,
  type ToolExecutionDAG,
} from './dagScheduler';
