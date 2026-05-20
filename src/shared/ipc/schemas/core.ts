import { z } from 'zod';

export const IPCRequestSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    action: z.string(),
    payload: payload.optional(),
    requestId: z.string().optional(),
  });

export const IPCResponseSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion('success', [
    z.object({ success: z.literal(true), data }),
    z.object({
      success: z.literal(false),
      error: z.object({
        code: z.string(),
        message: z.string(),
        details: z.unknown().optional(),
      }),
    }),
  ]);

export interface ChannelSchema<
  P extends z.ZodType<unknown> = z.ZodType<unknown>,
  R extends z.ZodType<unknown> = z.ZodType<unknown>,
> {
  channel: string;
  payload: P;
  response?: R;
}

export type PayloadOf<S extends ChannelSchema> = z.infer<S['payload']>;
export type ResponseOf<S extends ChannelSchema> =
  NonNullable<S['response']> extends z.ZodType<unknown>
    ? z.infer<NonNullable<S['response']>>
    : void;

export function channelSchema<
  P extends z.ZodType<unknown>,
  R extends z.ZodType<unknown>,
>(args: { channel: string; payload: P; response?: R }): ChannelSchema<P, R> {
  return args;
}
