// ============================================================================
// Capture API Routes - 浏览器插件 REST API
// ============================================================================

import type { Express, Request, Response } from 'express';
import { getCaptureService } from '../../services/captureService';
import { createLogger } from '../../services/infra/logger';
import type { CaptureRequest } from '@shared/types/capture';

const logger = createLogger('CaptureRoutes');

/**
 * 注册采集相关的 REST API 路由
 * 供浏览器插件通过 HTTP 调用
 */
export function registerCaptureRoutes(router: Express): void {
  const service = getCaptureService();

  // 采集内容
  router.post('/api/capture', async (req: Request, res: Response) => {
    try {
      const body = req.body as CaptureRequest;
      if (!body.title || !body.content) {
        res.status(400).json({ success: false, error: 'title and content are required' });
        return;
      }
      const item = await service.capture(body);
      res.json({ success: true, data: item });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Capture error', { error: message });
      res.status(500).json({ success: false, error: message });
    }
  });

  // 搜索采集内容
  router.get('/api/capture/search', async (req: Request, res: Response) => {
    try {
      const queryParam = Array.isArray(req.query.q) ? req.query.q[0] : req.query.q;
      const query = String(queryParam || '');
      const topKParam = Array.isArray(req.query.topK) ? req.query.topK[0] : req.query.topK;
      const topK = parseInt(String(topKParam || '10')) || 10;
      if (!query) {
        res.status(400).json({ success: false, error: 'query parameter q is required' });
        return;
      }
      const results = await service.search(query, topK);
      res.json({ success: true, data: results });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Search error', { error: message });
      res.status(500).json({ success: false, error: message });
    }
  });

  // 列出采集内容
  router.get('/api/capture/list', (req: Request, res: Response) => {
    try {
      const limitStr = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
      const offsetStr = Array.isArray(req.query.offset) ? req.query.offset[0] : req.query.offset;
      const sourceStr = Array.isArray(req.query.source) ? req.query.source[0] : req.query.source;
      const limit = parseInt(String(limitStr || '50')) || 50;
      const offset = parseInt(String(offsetStr || '0')) || 0;
      const items = service.list({ source: sourceStr as never, limit, offset });
      res.json({ success: true, data: items });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: message });
    }
  });

  // 获取单项（注意：放在 /stats 之后避免路由冲突）
  router.get('/api/capture/item/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const item = service.get(id);
    if (!item) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    res.json({ success: true, data: item });
  });

  // 删除
  router.delete('/api/capture/item/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const ok = service.delete(id);
    res.json({ success: true, data: ok });
  });

  // 统计
  router.get('/api/capture/stats', (_req: Request, res: Response) => {
    const stats = service.getStats();
    res.json({ success: true, data: stats });
  });

  logger.info('Capture routes registered');
}
