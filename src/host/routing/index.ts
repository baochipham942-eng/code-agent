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
} from '../../shared/contract/agentRouting';

// Intent Classifier (research orchestration)
export {
  IntentClassifier,
  type IntentClassifierConfig,
} from './intentClassifier';
