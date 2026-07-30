import { Router } from 'express';
import type { Request, Response } from 'express';
import { formatError } from '../helpers/utils';
import type { WebRouteHandler, WebRouteLogger } from './routeTypes';

interface DomainDeps {
  handlers: Map<string, WebRouteHandler>;
  logger: Pick<WebRouteLogger, 'warn' | 'error'>;
}

interface DomainRequestBody {
  payload?: unknown;
  requestId?: unknown;
}

function isAdminAccessError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; name?: unknown };
  return record.code === 'FORBIDDEN' || record.name === 'AdminAccessError';
}

function sendIpcHandlerError(res: Response, error: unknown): void {
  if (isAdminAccessError(error)) {
    res.json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: formatError(error),
      },
    });
    return;
  }

  res.status(500).json({
    success: false,
    error: {
      code: 'HANDLER_ERROR',
      message: formatError(error),
    },
  });
}

function readDomainRequestBody(body: unknown): DomainRequestBody {
  if (!body || typeof body !== 'object') return {};
  const record = body as Record<string, unknown>;
  return {
    payload: record.payload,
    requestId: record.requestId,
  };
}

/**
 * IPC handler 返回 undefined（写操作/void 通道，如 skill:project:set）时，
 * `res.json(undefined)` 会发出**空 body 的 200**，renderer 的 `response.json()`
 * 随即抛 "Unexpected end of JSON input" —— 表现为「明明写成功了却报错/没反应」
 * （2026-07-30 产品负责人真机撞到：空间右栏选技能，host 已落库，UI 报解析失败）。
 * 桥的唯一出口在这里统一兜：void 结果一律回 `null`（合法 JSON），
 * 别让每个 void 通道各自去凑一个假返回值。
 */
function sendJsonResult(res: Response, result: unknown): void {
  res.json(result === undefined ? null : result);
}

export function createDomainRouter(deps: DomainDeps): Router {
  const router = Router();
  const { handlers, logger } = deps;

  // ── Domain Router (universal) ──────────────────────────────────────
  // Matches what httpTransport.ts's createHttpDomainAPI() calls:
  //   POST /api/domain/:domain/:action
  router.post('/domain/:domain/:action', async (req: Request, res: Response) => {
    const domain = String(req.params.domain);
    const action = String(req.params.action);
    const { payload, requestId } = readDomainRequestBody(req.body as unknown);

    // 查找 handler — IPC handler 注册时使用的 channel 名
    // 有些用 IPC_DOMAINS.XXX (如 'domain:session', 'domain:agent')
    // 有些用 IPC_CHANNELS.XXX (如 'session:list', 'settings:get')
    const handler = handlers.get(domain) || handlers.get(`domain:${domain}`);

    if (handler) {
      try {
        const result = await handler(null, { action, payload, requestId });
        sendJsonResult(res, result);
      } catch (error) {
        logger.error(`Domain handler error: ${domain}:${action}`, error);
        sendIpcHandlerError(res, error);
      }
      return;
    }

    // 尝试 "domain:action" 格式的直接通道匹配
    const directChannel = `${domain}:${action}`;
    const directHandler = handlers.get(directChannel);

    if (directHandler) {
      try {
        const result = await directHandler(null, payload);
        sendJsonResult(res, result);
      } catch (error) {
        logger.error(`Direct handler error: ${directChannel}`, error);
        sendIpcHandlerError(res, error);
      }
      return;
    }

    logger.warn(`No handler for domain: ${domain}, action: ${action}`);
    logger.warn(`Available handlers: ${[...handlers.keys()].join(', ')}`);
    res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `No handler for domain:${domain} action:${action}`,
      },
    });
  });

  // ── Fallback for unmapped IPC channels ─────────────────────────────
  // httpTransport.ts's channelToEndpoint() maps some channels to
  // generic paths like /api/memory/search-code
  router.all('/:channel/{*rest}', async (req: Request, res: Response) => {
    // Reconstruct channel name: /api/memory/search-code -> memory:search-code
    const pathParts = req.path.replace(/^\//, '').split('/');
    const channel = pathParts.join(':');

    const handler = handlers.get(channel);
    if (handler) {
      try {
        const body: unknown = req.method === 'GET' ? req.query : req.body;
        // Spread array bodies as positional args to match Electron IPC convention:
        // ipcMain.handle(ch, (event, arg1, arg2, ...)) expects separate arguments
        const args: unknown[] = Array.isArray(body) ? [...body as unknown[]] : [body];
        const result = await handler(null, ...args);
        sendJsonResult(res, result);
      } catch (error) {
        if (isAdminAccessError(error)) {
          res.json({
            success: false,
            error: {
              code: 'FORBIDDEN',
              message: formatError(error),
            },
          });
          return;
        }
        res.status(500).json({ error: formatError(error) });
      }
      return;
    }

    res.status(404).json({ error: `Unknown channel: ${channel}` });
  });

  return router;
}
