import { z } from 'zod';
import { COMPANION_LIMITS as L } from '../constants/companion';

/** Project grants are explicit desktop choices; existing session grants stay narrow. */
export const projectGrant = (id: string) => `project:${id}`;
export const companionReadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('library'), offset: z.number().int().nonnegative().safe().default(0) }).strict(),
  z.object({ kind: z.literal('history'), sessionId: z.string().min(1).max(L.idLength),
    offset: z.number().int().nonnegative().safe().default(0) }).strict(),
]);
export type CompanionRead = z.infer<typeof companionReadSchema>;
export interface CompanionSessionSummary {
  id: string; title: string; projectId: string | null; updatedAt: number; archived: boolean;
  provider: string; model: string;
}
export interface CompanionLibrary {
  nextOffset: number | null;
  projects: { id: string; name: string; canCreate: boolean }[];
  sessions: CompanionSessionSummary[];
  models: { provider: string; model: string; label: string; providerLabel: string }[];
}
export interface CompanionHistory {
  sessionId: string;
  messages: { id: string; role: string; content: string; timestamp: number; truncated?: boolean }[];
  nextOffset: number | null;
}
