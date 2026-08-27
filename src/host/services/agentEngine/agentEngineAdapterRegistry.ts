import type { ExternalAgentEngineKind } from '../../../shared/contract/agentEngine';
import { AgentEngineCapabilityError } from '../../../shared/contract/agentEngine';
import { getExternalEngineManifestForKind } from '../../../shared/externalEngineManifest';
import { KimiAcpAdapter } from './acpClientAdapter';
import { ClaudeCodeAdapter } from './claudeCodeAdapter';
import { CodeBuddyCliAdapter } from './codeBuddyCliAdapter';
import { CodexCliAdapter } from './codexCliAdapter';
import { DshCliAdapter } from './dshCliAdapter';
import { GrokCliAdapter } from './grokCliAdapter';
import { KimiCliAdapter } from './kimiCliAdapter';
import { MimoCliAdapter } from './mimoCliAdapter';

export type ExternalEngineAdapter =
  | KimiAcpAdapter
  | ClaudeCodeAdapter
  | CodeBuddyCliAdapter
  | CodexCliAdapter
  | DshCliAdapter
  | GrokCliAdapter
  | KimiCliAdapter
  | MimoCliAdapter;

type ExternalEngineAdapterFactory = () => ExternalEngineAdapter;

// Map 而不是对象字面量：adapterId 带下划线（claude_code / codex_cli…），对象字面量方法名会撞
// naming-convention ratchet；Map 的 key 是数据不是标识符。
const ADAPTER_FACTORIES: ReadonlyMap<string, ExternalEngineAdapterFactory> = new Map<string, ExternalEngineAdapterFactory>([
  ['claude_code', () => new ClaudeCodeAdapter()],
  ['codebuddy_code', () => new CodeBuddyCliAdapter()],
  ['codex_cli', () => new CodexCliAdapter()],
  ['dsh_cli', () => new DshCliAdapter()],
  ['grok_cli', () => new GrokCliAdapter()],
  ['kimi_code', () => new KimiCliAdapter()],
  ['kimi_code_acp', () => new KimiAcpAdapter()],
  ['mimo_code', () => new MimoCliAdapter()],
]);

export function getExternalEngineAdapter(kind: ExternalAgentEngineKind): ExternalEngineAdapter {
  const manifest = getExternalEngineManifestForKind(kind);
  const adapterId = manifest?.adapter.adapterId;
  const factory = adapterId ? ADAPTER_FACTORIES.get(adapterId) : undefined;
  if (!factory) {
    throw new AgentEngineCapabilityError(kind, 'execute');
  }
  return factory();
}
