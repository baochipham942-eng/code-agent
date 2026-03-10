// ============================================================================
// Routing Module - Agent Routing System
// ============================================================================

export {
  getRoutingService,
  resetRoutingService,
  RoutingService,
} from './routingService';

export type {
  AgentRoutingConfig,
  AgentBinding,
  BindingType,
  BindingMatch,
  RoutingContext,
  RoutingResolution,
  AgentsConfigFile,
  AgentRoutingEvent,
} from '../../shared/types/agentRouting';

// Intent Classifier (unified — research + hybrid agent routing)
export {
  IntentClassifier,
  type IntentClassifierConfig,
  type TaskIntent,
  classifyIntent,
} from './intentClassifier';
