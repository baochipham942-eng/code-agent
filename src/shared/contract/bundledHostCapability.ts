export type BundledHostCapabilityId = 'builtin.voice-live' | 'builtin.voice-input';

export interface BundledHostCapabilityState {
  id: BundledHostCapabilityId;
  installed: boolean;
  version: string;
  revision: number;
}

export interface BundledHostCapabilityReadiness {
  id: BundledHostCapabilityId;
  status: 'ready' | 'fallback' | 'not_ready';
  detail: string;
  installCommand?: string;
  preservesExternalAssetsOnUninstall: boolean;
}
