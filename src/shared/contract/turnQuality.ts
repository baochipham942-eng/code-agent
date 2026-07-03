import type {
  MemoryEntryEvidence,
  MemoryEntryKind,
  MemoryEntryScope,
  MemoryEntrySourceRef,
  MemoryEntryStatus,
} from './memory';
import type { ModelProvider } from './model';
import type { SessionMemoryMode } from './session';

export type TurnQualityMemoryBlockType =
  | 'seed-memory'
  | 'memory_index'
  | 'memory_hint'
  | 'recent_conversations'
  | 'failure_journal';

export interface TurnQualityMemoryItem {
  entryId: string;
  title: string;
  kind: MemoryEntryKind;
  scope: MemoryEntryScope;
  status: MemoryEntryStatus;
  score?: number;
  scoreReasons?: string[];
  source?: MemoryEntrySourceRef;
  evidence?: MemoryEntryEvidence[];
  preview?: string;
  truncated?: boolean;
}

export interface TurnQualityMemoryBlock {
  blockType: TurnQualityMemoryBlockType;
  trigger: string;
  source: string;
  injected: boolean;
  chars: number;
  count: number;
  selectedCount?: number;
  totalCandidates?: number;
  budget?: number;
  items?: TurnQualityMemoryItem[];
}

export interface TurnQualityMemorySummary {
  mode: SessionMemoryMode;
  blocks: TurnQualityMemoryBlock[];
  suppressedEntryIds?: string[];
  offReason?: string;
}

export interface TurnQualityStrategySummary {
  provider: ModelProvider;
  model: string;
  requestedProvider?: ModelProvider;
  requestedModel?: string;
  adaptive?: boolean;
  effortLevel?: string;
  profile?: 'fast' | 'main' | 'deep' | 'vision';
  ruleId?: string;
  reason?: string;
  decisionReason?: string;
  complexity?: {
    level: 'simple' | 'moderate' | 'complex';
    score: number;
    signals: string[];
  };
  fallback?: {
    from: { provider: string; model?: string };
    to: { provider: string; model?: string };
    reason: string;
    category: string;
  };
}

export interface TurnQualityCapabilitySummary {
  agentId?: string;
  agentName?: string;
  /** 用户显式 /agent 请求的 agent id；与 agentId 不一致 = 显式选择降级为其他 agent 执行 */
  requestedAgentId?: string;
  activeSkillName?: string;
  toolsUsed?: string[];
}

export type TurnQualityScoreDimension =
  | 'strategy'
  | 'memory'
  | 'capability'
  | 'tooling'
  | 'delivery';

export interface TurnQualityScoreBreakdown {
  dimension: TurnQualityScoreDimension;
  score: number;
  max: number;
  status: 'good' | 'watch' | 'risk';
  reasons: string[];
}

export interface TurnQualityScoreSummary {
  score: number;
  max: number;
  grade: 'excellent' | 'good' | 'watch' | 'risk';
  breakdown: TurnQualityScoreBreakdown[];
}

export interface AgentQualityScorecard {
  agentId?: string;
  agentName?: string;
  model: string;
  strategyProfile?: TurnQualityStrategySummary['profile'];
  memoryUsed: number;
  toolsUsed: number;
  warnings: number;
  score: TurnQualityScoreSummary;
}

export interface TurnQualitySummary {
  memory: TurnQualityMemorySummary;
  strategy: TurnQualityStrategySummary;
  capabilities?: TurnQualityCapabilitySummary;
  score: TurnQualityScoreSummary;
  agentScorecard?: AgentQualityScorecard;
  warnings?: string[];
}
