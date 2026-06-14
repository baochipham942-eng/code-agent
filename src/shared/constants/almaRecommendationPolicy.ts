import type { RecommendedMcpServerEntry } from '../contract/mcpCatalog';
import type {
  AlmaBundledSkillMapping,
  AlmaBundledSkillRecommendation,
} from './skillCatalog';
import type {
  AlmaFeaturedPluginEntry,
  AlmaPluginRecommendationTier,
} from './almaPluginRegistry';

export type AlmaRecommendationPolicyTier =
  | 'default_visible'
  | 'conditional'
  | 'not_default'
  | 'unsupported';

export type AlmaRecommendationSubjectKind = 'mcp' | 'skill' | 'plugin';

export type AlmaRecommendationAction =
  | 'show_in_default_surface'
  | 'show_when_relevant'
  | 'reference_only'
  | 'hide_from_default'
  | 'block_install';

export interface AlmaRecommendationPolicy {
  kind: AlmaRecommendationSubjectKind;
  id: string;
  name: string;
  tier: AlmaRecommendationPolicyTier;
  source: 'alma_mcp_registry' | 'alma_bundled_skill' | 'alma_plugin_registry';
  label: string;
  action: AlmaRecommendationAction;
  reason: string;
  riskNote?: string;
  coveredBy?: string;
}

export const ALMA_RECOMMENDATION_TIER_LABELS: Record<AlmaRecommendationPolicyTier, string> = {
  default_visible: '默认展示',
  conditional: '条件推荐',
  not_default: '暂不默认',
  unsupported: '暂不支持',
};

function getPolicyAction(tier: AlmaRecommendationPolicyTier): AlmaRecommendationAction {
  switch (tier) {
    case 'default_visible':
      return 'show_in_default_surface';
    case 'conditional':
      return 'show_when_relevant';
    case 'not_default':
      return 'reference_only';
    case 'unsupported':
      return 'block_install';
    default:
      return 'reference_only';
  }
}

function normalizeMcpTier(entry: RecommendedMcpServerEntry): AlmaRecommendationPolicyTier {
  if (entry.recommendationTier) {
    return entry.recommendationTier;
  }
  return entry.officialFeatured ? 'conditional' : 'not_default';
}

function normalizeSkillTier(
  recommendation: AlmaBundledSkillRecommendation,
): AlmaRecommendationPolicyTier {
  switch (recommendation) {
    case 'covered':
      return 'not_default';
    case 'default_visible':
      return 'default_visible';
    case 'conditional':
      return 'conditional';
    case 'unsupported':
      return 'unsupported';
    default:
      return 'unsupported';
  }
}

function normalizePluginTier(
  tier: AlmaPluginRecommendationTier,
): AlmaRecommendationPolicyTier {
  return tier;
}

export function getAlmaMcpRecommendationPolicy(
  entry: RecommendedMcpServerEntry,
): AlmaRecommendationPolicy {
  const tier = normalizeMcpTier(entry);
  return {
    kind: 'mcp',
    id: entry.id,
    name: entry.name,
    tier,
    source: 'alma_mcp_registry',
    label: ALMA_RECOMMENDATION_TIER_LABELS[tier],
    action: getPolicyAction(tier),
    reason: entry.riskNote || (
      entry.officialFeatured
        ? '来自 Alma MCP registry featured；安装和启用仍按 code-agent 风险策略处理。'
        : 'code-agent 本地 curated MCP 条目，不属于 Alma 官方精选。'
    ),
    riskNote: entry.riskNote,
  };
}

export function getAlmaSkillRecommendationPolicy(
  mapping: AlmaBundledSkillMapping,
): AlmaRecommendationPolicy {
  const tier = normalizeSkillTier(mapping.recommendation);
  return {
    kind: 'skill',
    id: mapping.name,
    name: mapping.displayName,
    tier,
    source: 'alma_bundled_skill',
    label: mapping.recommendation === 'covered'
      ? '已覆盖'
      : ALMA_RECOMMENDATION_TIER_LABELS[tier],
    action: mapping.recommendation === 'covered'
      ? 'reference_only'
      : getPolicyAction(tier),
    reason: mapping.rationale,
    coveredBy: mapping.recommendation === 'covered' ? mapping.codeAgentSurface : undefined,
  };
}

export function getAlmaPluginRecommendationPolicy(
  plugin: AlmaFeaturedPluginEntry,
): AlmaRecommendationPolicy {
  const tier = normalizePluginTier(plugin.recommendationTier);
  return {
    kind: 'plugin',
    id: plugin.id,
    name: plugin.name,
    tier,
    source: 'alma_plugin_registry',
    label: ALMA_RECOMMENDATION_TIER_LABELS[tier],
    action: getPolicyAction(tier),
    reason: plugin.codeAgentStatus,
    riskNote: plugin.riskNote,
  };
}
