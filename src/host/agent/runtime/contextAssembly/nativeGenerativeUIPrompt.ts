import {
  EXECUTION_MANIFEST_GENERATIVE_UI_PROMPT,
  NATIVE_GENERATIVE_UI_PROMPT,
} from '../../../prompts/generativeUI';
import { getFeatureFlagService } from '../../../services/cloud/featureFlagService';
import { appendPromptBlockWithinBudget } from './promptBudget';
import type { ContextAssemblyCtx } from './shared';

export function appendNativeGenerativeUIPromptBlocks(
  systemPrompt: string,
  ctx: ContextAssemblyCtx,
  appendedBlocks: Map<string, string>,
): string {
  const flags = getFeatureFlagService();
  const nativeEnabled = process.env.CODE_AGENT_NATIVE_GENERATIVE_UI === '1'
    || flags.isEnabled('nativeGenerativeUI');
  if (!nativeEnabled) return systemPrompt;

  let next = appendPromptBlockWithinBudget(systemPrompt, NATIVE_GENERATIVE_UI_PROMPT, 'native generative UI', ctx);
  if (next.includes(NATIVE_GENERATIVE_UI_PROMPT)) appendedBlocks.set('native generative UI', NATIVE_GENERATIVE_UI_PROMPT);
  const manifestEnabled = process.env.CODE_AGENT_EXECUTION_MANIFEST_V1 === '1'
    || flags.isEnabled('executionManifestV1');
  if (!manifestEnabled) return next;

  next = appendPromptBlockWithinBudget(
    next,
    EXECUTION_MANIFEST_GENERATIVE_UI_PROMPT,
    'execution manifest generative UI',
    ctx,
  );
  if (next.includes(EXECUTION_MANIFEST_GENERATIVE_UI_PROMPT)) {
    appendedBlocks.set('execution manifest generative UI', EXECUTION_MANIFEST_GENERATIVE_UI_PROMPT);
  }
  return next;
}
