import { Router } from 'express';
import type { Request, Response } from 'express';
import type { HandlerFn } from '../electronMock';
import { formatError } from '../helpers/utils';

interface DomainDeps {
  handlers: Map<string, HandlerFn>;
  logger: { warn: (msg: string, ...args: any[]) => void; error: (msg: string, ...args: any[]) => void };
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
    const { payload, requestId } = req.body;

    // 查找 handler — IPC handler 注册时使用的 channel 名
    // 有些用 IPC_DOMAINS.XXX (如 'domain:session', 'domain:agent')
    // 有些用 IPC_CHANNELS.XXX (如 'session:list', 'settings:get')
    const handler = handlers.get(domain) || handlers.get(`domain:${domain}`);

    if (handler) {
      try {
        const result = await handler(null, { action, payload, requestId });
        res.json(result);
      } catch (error) {
        logger.error(`Domain handler error: ${domain}:${action}`, error);
        res.status(500).json({
          success: false,
          error: {
            code: 'HANDLER_ERROR',
            message: formatError(error),
          },
        });
      }
      return;
    }

    // 尝试 "domain:action" 格式的直接通道匹配
    const directChannel = `${domain}:${action}`;
    const directHandler = handlers.get(directChannel);

    if (directHandler) {
      try {
        const result = await directHandler(null, payload);
        res.json(result);
      } catch (error) {
        logger.error(`Direct handler error: ${directChannel}`, error);
        res.status(500).json({
          success: false,
          error: {
            code: 'HANDLER_ERROR',
            message: formatError(error),
          },
        });
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
        const body = req.method === 'GET' ? req.query : req.body;
        // Spread array bodies as positional args to match Electron IPC convention:
        // ipcMain.handle(ch, (event, arg1, arg2, ...)) expects separate arguments
        const result = Array.isArray(body)
          ? await handler(null, ...body)
          : await handler(null, body);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: formatError(error) });
      }
      return;
    }

    res.status(404).json({ error: `Unknown channel: ${channel}` });
  });

  return router;
}
