// ============================================================================
// Shell Capability Contract
// ============================================================================

export type ShellCapabilityRisk = 'low' | 'medium' | 'high';
export type ShellCapabilityLayer = 'domain' | 'native';

export interface ShellCapability {
  id: string;
  domain: string;
  action: string;
  layer: ShellCapabilityLayer;
  since: string;
  risk: ShellCapabilityRisk;
  description?: string;
}

export interface ShellCapabilitiesManifest {
  schemaVersion: 1;
  appVersion: string;
  generatedAt: string;
  capabilities: ShellCapability[];
}

export const SHELL_CAPABILITY_DOMAINS = {
  TAURI: 'native:tauri',
} as const;

export function makeShellCapabilityId(domain: string, action: string): string {
  return `${domain}/${action}`;
}

export function makeTauriCommandCapabilityId(command: string): string {
  return makeShellCapabilityId(SHELL_CAPABILITY_DOMAINS.TAURI, command);
}

export function shellCapabilityLayerForDomain(domain: string): ShellCapabilityLayer {
  return domain.startsWith('native:') ? 'native' : 'domain';
}

export function shellCapabilityLayerForId(id: string): ShellCapabilityLayer {
  return shellCapabilityLayerForDomain(id.split('/')[0] || id);
}

export function missingShellCapabilities(
  supportedCapabilities: readonly string[],
  requiredCapabilities: readonly string[] | undefined,
): string[] {
  if (!requiredCapabilities?.length) return [];
  const supported = new Set(supportedCapabilities);
  return [...new Set(requiredCapabilities)].filter((id) => !supported.has(id));
}
