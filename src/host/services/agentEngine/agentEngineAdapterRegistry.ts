import type { ExternalAgentEngineKind } from '../../../shared/contract/agentEngine';
import { AgentEngineCapabilityError } from '../../../shared/contract/agentEngine';
import { getExternalEngineManifestForKind } from '../../../shared/externalEngineManifest';
import { ClaudeCodeAdapter } from './claudeCodeAdapter';
import { CodeBuddyCliAdapter } from './codeBuddyCliAdapter';
import { CodexCliAdapter } from './codexCliAdapter';
import { DshCliAdapter } from './dshCliAdapter';
import { GrokCliAdapter } from './grokCliAdapter';
import { KimiCliAdapter } from './kimiCliAdapter';
import { MimoCliAdapter } from './mimoCliAdapter';

export type ExternalEngineAdapter =
  | ClaudeCodeAdapter
  | CodeBuddyCliAdapter
  | CodexCliAdapter
  | DshCliAdapter
  | GrokCliAdapter
  | KimiCliAdapter
  | MimoCliAdapter;

type ExternalEngineAdapterFactory = () => ExternalEngineAdapter;

const ADAPTER_FACTORIES: Readonly<Record<string, ExternalEngineAdapterFactory>> = Object.freeze({
  claude_code: () => new ClaudeCodeAdapter(),
  codebuddy_code: () => new CodeBuddyCliAdapter(),
  codex_cli: () => new CodexCliAdapter(),
  dsh_cli: () => new DshCliAdapter(),
  grok_cli: () => new GrokCliAdapter(),
  kimi_code: () => new KimiCliAdapter(),
  mimo_code: () => new MimoCliAdapter(),
});

export function getExternalEngineAdapter(kind: ExternalAgentEngineKind): ExternalEngineAdapter {
  const manifest = getExternalEngineManifestForKind(kind);
  const adapterId = manifest?.adapter.adapterId;
  const factory = adapterId ? ADAPTER_FACTORIES[adapterId] : undefined;
  if (!factory) {
    throw new AgentEngineCapabilityError(kind, 'execute');
  }
  return factory();
}
