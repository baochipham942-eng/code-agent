export type BundledHostCapabilityId = 'builtin.voice-live' | 'builtin.voice-input';

export interface BundledHostCapabilityState {
  id: BundledHostCapabilityId;
  installed: boolean;
  version: string;
  revision: number;
}
