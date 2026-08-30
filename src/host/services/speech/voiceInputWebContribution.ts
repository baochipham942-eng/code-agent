import type { HostWebRouteContribution } from '../capabilities/hostCapabilityContributions';
import { getDashscopeApiKey } from '../media/imageGenerationService';

export function createVoiceInputWebRouteContribution(): HostWebRouteContribution {
  return {
    path: '/speech/status',
    handler(_request, response) {
      response.json({ configured: Boolean(getDashscopeApiKey()) });
    },
  };
}
