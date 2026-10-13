import type { ToolRegistry } from '../../registry';
import { delegateSessionSchema } from './delegateSession.schema';
import { listSessionCandidatesSchema } from './listSessionCandidates.schema';

export function registerCrossSessionDelegationTools(registry: ToolRegistry): void {
  registry.register(delegateSessionSchema, async () => (await import('./delegateSession')).delegateSessionModule);
  registry.register(listSessionCandidatesSchema, async () => (await import('./listSessionCandidates')).listSessionCandidatesModule);
}
