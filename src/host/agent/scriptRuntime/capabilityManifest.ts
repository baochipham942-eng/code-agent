import type { ToolProfile } from './toolProfiles';
import type { CapabilityManifest } from '../../../shared/contract/agentCapabilities';
export type { CapabilityManifest } from '../../../shared/contract/agentCapabilities';

export const ORCHESTRATION_CAPABILITIES: Readonly<CapabilityManifest> = Object.freeze({
  fileRead: false,
  fileWrite: false,
  shell: false,
  network: false,
  credential: false,
  childProcess: false,
});

const PROFILE_CAPABILITIES: Record<ToolProfile, Readonly<CapabilityManifest>> = {
  readonly: Object.freeze({
    fileRead: true,
    fileWrite: false,
    shell: false,
    network: true,
    credential: false,
    childProcess: false,
  }),
  edit: Object.freeze({
    fileRead: true,
    fileWrite: true,
    shell: false,
    network: true,
    credential: false,
    childProcess: false,
  }),
  full: Object.freeze({
    fileRead: true,
    fileWrite: true,
    shell: true,
    network: true,
    credential: false,
    childProcess: true,
  }),
};

export function capabilityManifestForToolProfile(profile: ToolProfile): Readonly<CapabilityManifest> {
  return PROFILE_CAPABILITIES[profile];
}

export function capabilityManifestForTools(tools: string[]): Readonly<CapabilityManifest> {
  const normalized = new Set(tools.map((tool) => tool.toLowerCase()));
  const shell = normalized.has('bash');
  return Object.freeze({
    fileRead: ['read', 'glob', 'grep'].some((tool) => normalized.has(tool)),
    fileWrite: ['write', 'edit'].some((tool) => normalized.has(tool)),
    shell,
    network: ['websearch', 'webfetch', 'browser', 'computer'].some((tool) => normalized.has(tool)),
    credential: false,
    childProcess: shell,
  });
}
