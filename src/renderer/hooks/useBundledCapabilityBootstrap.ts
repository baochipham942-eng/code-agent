import { useEffect } from 'react';
import { subscribeBundledCapabilityState } from '../stores/bundledCapabilityStore';

export function useBundledCapabilityBootstrap(): void {
  useEffect(() => subscribeBundledCapabilityState(), []);
}
