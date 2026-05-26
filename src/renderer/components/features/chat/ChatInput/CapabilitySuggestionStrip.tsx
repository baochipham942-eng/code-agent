import React from 'react';
import { Sparkles } from 'lucide-react';
import type { WorkbenchCapabilityRegistryItem } from '../../../../utils/workbenchCapabilityRegistry';

export interface SkillRecommendationView {
  skillName: string;
  libraryId: string;
  reason: string;
}

function normalizeCapabilityText(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

function getCapabilitySuggestionKindLabel(kind: WorkbenchCapabilityRegistryItem['kind']): string {
  if (kind === 'skill') return 'Skill';
  if (kind === 'connector') return 'Connector';
  return 'MCP';
}

function getCapabilitySuggestionHaystack(capability: WorkbenchCapabilityRegistryItem): string {
  const parts = [capability.id, capability.label];
  if (capability.kind === 'skill') {
    parts.push(capability.description || '', capability.source || '', capability.libraryId || '');
  }
  if (capability.kind === 'connector') {
    parts.push(capability.detail || '', capability.error || '', ...(capability.capabilities || []));
  }
  if (capability.kind === 'mcp') {
    parts.push(capability.status, capability.transport || '', capability.error || '');
  }
  return parts.map(normalizeCapabilityText).filter(Boolean).join(' ');
}

export function buildCapabilitySemanticSuggestions(
  input: string,
  capabilities: WorkbenchCapabilityRegistryItem[],
): WorkbenchCapabilityRegistryItem[] {
  const query = normalizeCapabilityText(input);
  if (query.length < 2 || query.startsWith('/')) {
    return [];
  }
  const tokens = query.split(/[\s,，。.!?;；:：/\\()[\]{}"'`]+/).filter((token) => token.length >= 2);
  if (tokens.length === 0) {
    return [];
  }

  return capabilities
    .filter((capability) => !capability.selected && capability.kind !== 'mcp')
    .map((capability) => {
      const haystack = getCapabilitySuggestionHaystack(capability);
      const matchedTokens = tokens.filter((token) => haystack.includes(token));
      const labelHit = haystack.includes(query) ? 2 : 0;
      const hasTextMatch = matchedTokens.length > 0 || labelHit > 0;
      const availabilityBoost = capability.available ? 0.25 : 0;
      return {
        capability,
        score: hasTextMatch ? matchedTokens.length + labelHit + availabilityBoost : 0,
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.capability.label.localeCompare(right.capability.label))
    .map((item) => item.capability)
    .slice(0, 5);
}

interface CapabilitySuggestionStripProps {
  skillRecommendations: SkillRecommendationView[];
  capabilitySuggestions: WorkbenchCapabilityRegistryItem[];
  onSkillMount: (recommendation: SkillRecommendationView) => void;
  onCapabilitySelect: (capability: WorkbenchCapabilityRegistryItem) => void;
}

export const CapabilitySuggestionStrip: React.FC<CapabilitySuggestionStripProps> = ({
  skillRecommendations,
  capabilitySuggestions,
  onSkillMount,
  onCapabilitySelect,
}) => {
  if (skillRecommendations.length === 0 && capabilitySuggestions.length === 0) {
    return null;
  }

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.025] px-2.5 py-2">
      <Sparkles className="h-3.5 w-3.5 text-fuchsia-400" />
      {skillRecommendations.map((recommendation) => (
        <button
          key={`skill-rec:${recommendation.skillName}`}
          type="button"
          onClick={() => onSkillMount(recommendation)}
          className="inline-flex max-w-full items-center gap-1 rounded-md border border-fuchsia-400/20 bg-fuchsia-400/10 px-2 py-1 text-[11px] text-fuchsia-100 hover:border-fuchsia-400/40"
          title={recommendation.reason}
        >
          <span>挂载</span>
          <span className="truncate">{recommendation.skillName}</span>
        </button>
      ))}
      {capabilitySuggestions.map((capability) => (
        <button
          key={`capability-rec:${capability.key}`}
          type="button"
          onClick={() => onCapabilitySelect(capability)}
          className="inline-flex max-w-full items-center gap-1 rounded-md border border-white/[0.08] bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-300 hover:border-white/[0.14] hover:text-zinc-100"
          title={`${getCapabilitySuggestionKindLabel(capability.kind)}: ${capability.label}`}
        >
          <span className="text-zinc-500">{getCapabilitySuggestionKindLabel(capability.kind)}</span>
          <span className="truncate">{capability.label}</span>
        </button>
      ))}
    </div>
  );
};
