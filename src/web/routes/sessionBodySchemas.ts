import { z } from 'zod';

export const SessionCreateBodySchema = z.object({
  title: z.string().optional(),
  workingDirectory: z.string().optional(),
}).passthrough();
