// ============================================================================
// Typed Express body parser
// ============================================================================
//
// 用 zod schema 校验 `req.body`，失败时抛 400。把 Express 路由从
// `req.body.foo: any` 改成 `body.foo: <schema-typed>`。
//
// 用法:
// ```ts
// const RunBodySchema = z.object({
//   prompt: z.string(),
//   sessionId: z.string().optional(),
// });
//
// router.post('/run', async (req, res) => {
//   const body = parseBody(req, RunBodySchema);  // body: { prompt: string; sessionId?: string }
//   // ...
// });
// ```
// ============================================================================

import type { Request, Response, NextFunction } from 'express';
import type { z } from 'zod';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * 用 zod schema 校验 `req.body`。
 * 失败时抛 `HttpError(400, 'INVALID_BODY', ...)`，由路由的 try/catch
 * 或 `withTypedBody` 中间件转成 400 响应。
 */
export function parseBody<T extends z.ZodType<unknown>>(
  req: Request,
  schema: T,
): z.infer<T> {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    throw new HttpError(400, 'INVALID_BODY', result.error.message, result.error.issues);
  }
  return result.data as z.infer<T>;
}

/**
 * 把 HttpError 转成 JSON 错误响应的辅助 middleware。
 * 在路由 handler 抛 HttpError 后落到这里，统一格式。
 */
export function httpErrorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      success: false,
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  next(err);
}
