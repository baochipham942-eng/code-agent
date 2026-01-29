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
