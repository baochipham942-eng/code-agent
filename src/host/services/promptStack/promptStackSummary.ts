// ============================================================================
// Prompt Stack Summary
// ============================================================================
// Produces a metadata-only view of the current system prompt stack. This is the
// backend slice for a future Prompt Stack Inspector: useful for UI/debugging
// without exposing the full system prompt.
// ============================================================================

import { PROMPT_VERSION } from '../../../shared/constants/agent';
import type {
  PromptStackLayerId,
  PromptStackLayerSummary,
  PromptStackSummary,
} from '../../../shared/contract/promptStack';
import { estimateTokens } from '../../context/tokenEstimator';
import { DYNAMIC_BOUNDARY_MARKER } from '../../prompts/cacheBreakDetection';

function count(text: string): Pick<PromptStackLayerSummary, 'chars' | 'tokens'> {
  return {
    chars: text.length,
    tokens: estimateTokens(text),
  };
}

function makeLayer(
  id: PromptStackLayerId,
  label: string,
  text: string,
  present: boolean,
  note?: string,
): PromptStackLayerSummary {
  return {
    id,
    label,
    present,
    ...count(present ? text : ''),
    ...(note ? { note } : {}),
  };
}

function sliceBetween(text: string, startMarker: string, endMarker?: string): string {
  const start = text.indexOf(startMarker);
  if (start === -1) return '';
  const contentStart = start + startMarker.length;
  if (!endMarker) return text.slice(contentStart);
  const end = text.indexOf(endMarker, contentStart);
  return end === -1 ? text.slice(contentStart) : text.slice(contentStart, end);
}

function sliceBefore(text: string, marker: string): string {
  const end = text.indexOf(marker);
  return end === -1 ? '' : text.slice(0, end);
}

function sliceTaggedBlock(text: string, tagName: string): string {
  const open = new RegExp(`<${tagName}(?:\\s[^>]*)?>`).exec(text);
  if (open?.index === undefined) return '';
  const closeMarker = `</${tagName}>`;
  const close = text.indexOf(closeMarker, open.index + open[0].length);
  if (close === -1) return '';
  return text.slice(open.index, close + closeMarker.length);
}

function collectTaggedBlocks(text: string, tagNames: string[]): string {
  return tagNames
    .map((tagName) => sliceTaggedBlock(text, tagName))
    .filter(Boolean)
    .join('\n\n');
}

function hasAny(text: string, markers: string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}

export function summarizePromptStack(systemPrompt: string): PromptStackSummary {
  const [substrate, dynamic = ''] = systemPrompt.split(DYNAMIC_BOUNDARY_MARKER);
  const hasDynamicBoundary = systemPrompt.includes(DYNAMIC_BOUNDARY_MARKER);

  const soulText = sliceBetween(substrate, 'You are Agent Neo', '## Tools') || sliceBefore(substrate, '## Tools');
  const toolsText = sliceBetween(substrate, '## Tools', '## Tool Call Envelope');
  const envelopeText = sliceBetween(substrate, '## Tool Call Envelope', '## File');
  const remoteFragmentsText = sliceTaggedBlock(dynamic, 'signed_remote_prompt_fragments');
  const roleAssetsText = sliceTaggedBlock(systemPrompt, 'role_assets');
  const projectProfileText = sliceTaggedBlock(systemPrompt, 'project_profile');
  const skillText = collectTaggedBlocks(systemPrompt, [
    'preloaded_skills',
    'skill-instructions',
    'skill-execution-report',
  ]);
  const hasSkillGuidance = hasAny(systemPrompt, [
    '<skill',
    'Loading skill:',
    'SKILL.md',
    'Skills are product capabilities',
  ]);

  const layers: PromptStackLayerSummary[] = [
    makeLayer(
      'substrate',
      'Stable substrate',
      substrate,
      substrate.length > 0,
      'Identity, engineering rules, tool catalog, and tool envelope conventions.',
    ),
    makeLayer(
      'soul',
      'Soul / identity',
      soulText,
      substrate.includes('You are Agent Neo') || substrate.includes('<project_profile>'),
      'User SOUL.md replaces the identity block; project PROFILE.md may append project context.',
    ),
    makeLayer(
      'tools',
      'Tool catalog',
      toolsText,
      substrate.includes('## Tools'),
      'Visible tool usage rules and routing guidance.',
    ),
    makeLayer(
      'tool-envelope',
      'Tool envelope',
      envelopeText,
      substrate.includes('## Tool Call Envelope'),
      'Semantic metadata contract for user-visible tool activity.',
    ),
    makeLayer(
      'dynamic',
      'Dynamic overlays',
      dynamic,
      dynamic.length > 0,
      'Runtime fragments after the dynamic boundary: remote fragments, path rules, or profile overlays.',
    ),
    makeLayer(
      'remote-fragments',
      'Trusted remote fragments',
      remoteFragmentsText,
      remoteFragmentsText.length > 0 || dynamic.includes('trusted_remote') || dynamic.includes('remote prompt fragments'),
      'Control-plane prompt fragments, when configured.',
    ),
    makeLayer(
      'role-assets',
      'Role assets',
      roleAssetsText,
      roleAssetsText.length > 0,
      'Persistent role memory and recent work history.',
    ),
    makeLayer(
      'project-profile',
      'Project profile',
      projectProfileText,
      projectProfileText.length > 0,
      'Project-level PROFILE.md extension.',
    ),
    makeLayer(
      'skills',
      'Skill guidance',
      skillText || toolsText,
      hasSkillGuidance,
      'Mounted skill bodies or skill routing guidance.',
    ),
  ];

  const detectedCapabilities = layers
    .filter((layer) => layer.present)
    .map((layer) => layer.label);

  const warnings: string[] = [];
  if (!hasDynamicBoundary) {
    warnings.push('No dynamic boundary found; prompt cache attribution may be less granular.');
  }
  if (!layers.find((layer) => layer.id === 'tools')?.present) {
    warnings.push('Tool catalog marker not found.');
  }
  if (!layers.find((layer) => layer.id === 'skills')?.present) {
    warnings.push('No skill guidance detected in the current prompt text.');
  }

  return {
    promptVersion: PROMPT_VERSION,
    totalChars: systemPrompt.length,
    totalTokens: estimateTokens(systemPrompt),
    hasDynamicBoundary,
    layers,
    detectedCapabilities,
    warnings,
  };
}

export async function getCurrentPromptStackSummary(): Promise<PromptStackSummary> {
  const { SYSTEM_PROMPT } = await import('../../prompts/builder');
  return summarizePromptStack(String(SYSTEM_PROMPT));
}
