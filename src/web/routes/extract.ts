import { Router } from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import type { HandlerFn } from '../electronMock';
import { formatError } from '../helpers/utils';

interface ExtractDeps {
  handlers: Map<string, HandlerFn>;
}

export function createExtractRouter(deps: ExtractDeps): Router {
  const router = Router();
  const { handlers } = deps;

  router.post('/extract/pdf', async (req: Request, res: Response) => {
    try {
      const { filePath } = req.body ?? {};
      if (!filePath || typeof filePath !== 'string') {
        res.status(400).json({ error: 'Missing or invalid filePath' });
        return;
      }
      if (filePath.includes('..')) {
        res.status(403).json({ error: 'Path traversal not allowed' });
        return;
      }
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) {
        res.status(404).json({ error: 'File not found: ' + filePath });
        return;
      }

      const handler = handlers.get('extract-pdf-text');
      if (handler) {
        const result = await handler(null, resolved);
        res.json(result);
      } else {
        res.status(501).json({ error: 'extract-pdf-text handler not registered' });
      }
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  router.post('/extract/excel', async (req: Request, res: Response) => {
    try {
      const { filePath } = req.body ?? {};
      if (!filePath || typeof filePath !== 'string') {
        res.status(400).json({ error: 'Missing or invalid filePath' });
        return;
      }
      if (filePath.includes('..')) {
        res.status(403).json({ error: 'Path traversal not allowed' });
        return;
      }
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) {
        res.status(404).json({ error: 'File not found: ' + filePath });
        return;
      }

      const handler = handlers.get('extract-excel-text');
      if (handler) {
        const result = await handler(null, resolved);
        res.json(result);
      } else {
        res.status(501).json({ error: 'extract-excel-text handler not registered' });
      }
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  router.post('/extract/excel-json', async (req: Request, res: Response) => {
    try {
      const { filePath } = req.body ?? {};
      if (!filePath || typeof filePath !== 'string') {
        res.status(400).json({ error: 'Missing or invalid filePath' });
        return;
      }
      if (filePath.includes('..')) {
        res.status(403).json({ error: 'Path traversal not allowed' });
        return;
      }
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) {
        res.status(404).json({ error: 'File not found: ' + filePath });
        return;
      }

      const handler = handlers.get('extract-excel-json');
      if (handler) {
        const result = await handler(null, resolved);
        res.json(result);
      } else {
        res.status(501).json({ error: 'extract-excel-json handler not registered' });
      }
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  router.post('/extract/docx-html', async (req: Request, res: Response) => {
    try {
      const { filePath } = req.body ?? {};
      if (!filePath || typeof filePath !== 'string') {
        res.status(400).json({ error: 'Missing or invalid filePath' });
        return;
      }
      if (filePath.includes('..')) {
        res.status(403).json({ error: 'Path traversal not allowed' });
        return;
      }
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) {
        res.status(404).json({ error: 'File not found: ' + filePath });
        return;
      }

      const handler = handlers.get('extract-docx-html');
      if (handler) {
        const result = await handler(null, resolved);
        res.json(result);
      } else {
        res.status(501).json({ error: 'extract-docx-html handler not registered' });
      }
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  router.post('/speech/transcribe', async (req: Request, res: Response) => {
    try {
      const { audioData, mimeType } = req.body ?? {};
      if (!audioData || typeof audioData !== 'string') {
        res.status(400).json({ error: 'Missing or invalid audioData (base64 string)' });
        return;
      }
      if (!mimeType || typeof mimeType !== 'string') {
        res.status(400).json({ error: 'Missing or invalid mimeType' });
        return;
      }

      const handler = handlers.get('speech:transcribe');
      if (handler) {
        const result = await handler(null, { audioData, mimeType });
        res.json(result);
      } else {
        res.status(501).json({ error: 'speech:transcribe handler not registered' });
      }
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  return router;
}
