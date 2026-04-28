import { Router } from 'express';
import type { Request, Response } from 'express';
import { broadcastSSE } from '../helpers/sse';
import { formatError } from '../helpers/utils';
import {
  type CachedMessage,
  type CachedToolCall,
  type InMemorySession,
  sessionMessages,
  inMemorySessions,
} from '../helpers/sessionCache';

interface SessionsRouterDeps {
  logger: { info: (msg: string, ...args: any[]) => void; warn: (msg: string, ...args: any[]) => void; error: (msg: string, ...args: any[]) => void };
  tryGetSessionManager: () => Promise<any>;
  getSupabaseForSession: () => Promise<{ supabase: any; userId: string } | null>;
}

export function createSessionsRouter(deps: SessionsRouterDeps): Router {
  const router = Router();
  const { logger, tryGetSessionManager, getSupabaseForSession } = deps;

  router.get('/sessions', async (_req: Request, res: Response) => {
    try {
      const sm = await tryGetSessionManager();
      if (sm) {
        const includeArchived = _req.query.includeArchived === 'true';
        const sessions = await sm.listSessions({ includeArchived });
        res.json({ success: true, data: sessions });
        return;
      }
      // Supabase 降级：从云端读取会话列表
      const sb = await getSupabaseForSession();
      if (sb) {
        const { data, error } = await sb.supabase
          .from('sessions')
          .select('*')
          .eq('user_id', sb.userId)
          .eq('is_deleted', false)
          .order('updated_at', { ascending: false });
        if (error) throw error;
        res.json({ success: true, data: data || [] });
        return;
      }
      // 内存降级（最后兜底）：返回内存中的会话列表
      const includeArchived = _req.query.includeArchived === 'true';
      const sessions = [...inMemorySessions.values()]
        .filter(s => includeArchived || !s.isArchived)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      res.json({ success: true, data: sessions });
    } catch (error) {
      logger.error('GET /api/sessions failed:', error);
      res.json({ success: false, error: { code: 'DB_ERROR', message: formatError(error) } });
    }
  });

  router.post('/sessions', async (req: Request, res: Response) => {
    try {
      const sm = await tryGetSessionManager();
      if (sm) {
        const { resolveSessionDefaultModelConfig } = await import('../../main/services/core/sessionDefaults');
        const title = req.body?.title || 'New Session';
        const session = await sm.createSession({
          title,
          modelConfig: resolveSessionDefaultModelConfig(),
        });
        sm.setCurrentSession(session.id);
        res.json({ success: true, data: session });
        return;
      }
      // Supabase 降级：创建云端会话
      const sb = await getSupabaseForSession();
      if (sb) {
        const now = Date.now();
        const sessionId = `session_${now}_${Math.random().toString(36).slice(2, 8)}`;
        const { DEFAULT_PROVIDER, DEFAULT_MODELS } = await import('../../shared/constants');
        const newSession = {
          id: sessionId,
          user_id: sb.userId,
          title: req.body?.title || 'New Session',
          model_provider: DEFAULT_PROVIDER,
          model_name: DEFAULT_MODELS.chat,
          created_at: now,
          updated_at: now,
          source_device_id: 'web',
        };
        const { data, error } = await sb.supabase.from('sessions').insert(newSession).select().single();
        if (error) throw error;
        res.json({ success: true, data });
        return;
      }
      // 内存降级（最后兜底）：创建内存会话
      const now = Date.now();
      const session: InMemorySession = {
        id: `session_${now}_${Math.random().toString(36).slice(2, 8)}`,
        title: req.body?.title || 'New Session',
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
      };
      inMemorySessions.set(session.id, session);
      res.json({ success: true, data: session });
    } catch (error) {
      logger.error('POST /api/sessions failed:', error);
      res.json({ success: false, error: { code: 'DB_ERROR', message: formatError(error) } });
    }
  });

  router.get('/sessions/:id', async (req: Request, res: Response) => {
    try {
      const sessionId = req.params.id as string;
      const sm = await tryGetSessionManager();
      if (sm) {
        const session = await sm.restoreSession(sessionId);
        if (session) {
          // DB 路径找到了会话但消息可能为空 — 用内存缓存补充
          if (session.messages.length === 0 && sessionMessages.has(sessionId)) {
            const memMessages = (sessionMessages.get(sessionId) || []).map(m => ({
              ...m,
              toolCalls: (m as CachedMessage & { toolCalls?: CachedToolCall[] }).toolCalls || [],
            }));
            if (memMessages.length > 0) {
              logger.info('GET /api/sessions/:id — DB messages empty, falling back to in-memory cache', { sessionId, memCount: memMessages.length });
              session.messages = memMessages as import('../../shared/contract').Message[];
            }
          }
          res.json({ success: true, data: session });
          return;
        }
        // SM 找不到会话 — 不要直接返回 NOT_FOUND，继续尝试内存/Supabase 降级
        logger.info('GET /api/sessions/:id — SM returned null, trying fallback', { sessionId });
      }
      // Supabase 降级：从云端读取会话 + 消息
      const sb = await getSupabaseForSession();
      if (sb) {
        const { data: sessionData, error: sessionErr } = await sb.supabase
          .from('sessions')
          .select('*')
          .eq('id', sessionId)
          .eq('user_id', sb.userId)
          .eq('is_deleted', false)
          .single();
        if (sessionErr || !sessionData) {
          res.json({ success: false, error: { code: 'NOT_FOUND', message: `Session ${sessionId} not found` } });
          return;
        }
        const { data: msgData } = await sb.supabase
          .from('messages')
          .select('*')
          .eq('session_id', sessionId)
          .eq('is_deleted', false)
          .order('timestamp', { ascending: true });
        const messages = (msgData || []).map((m: any) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          toolCalls: m.tool_calls || [],
        }));
        res.json({ success: true, data: { ...sessionData, messages, todos: [] } });
        return;
      }
      // 内存降级（最后兜底）：返回内存会话 + 缓存的消息
      const session = inMemorySessions.get(sessionId);
      if (!session) {
        res.json({ success: false, error: { code: 'NOT_FOUND', message: `Session ${sessionId} not found` } });
        return;
      }
      const messages = (sessionMessages.get(sessionId) || []).map(m => ({
        ...m,
        // 保留已缓存的 toolCalls，不覆盖为空数组（否则 tool-only 助手消息会被前端过滤掉）
        toolCalls: (m as CachedMessage & { toolCalls?: CachedToolCall[] }).toolCalls || [],
      }));
      res.json({ success: true, data: { ...session, messages, todos: [] } });
    } catch (error) {
      logger.error('GET /api/sessions/:id failed:', error);
      res.json({ success: false, error: { code: 'DB_ERROR', message: formatError(error) } });
    }
  });

  router.get('/sessions/:id/messages', async (req: Request, res: Response) => {
    try {
      const sessionId = req.params.id as string;
      const sm = await tryGetSessionManager();
      if (sm) {
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        const messages = await sm.getMessages(sessionId, limit);
        res.json({ success: true, data: messages });
        return;
      }
      // Supabase 降级：从云端读取消息
      const sb = await getSupabaseForSession();
      if (sb) {
        let query = sb.supabase
          .from('messages')
          .select('*')
          .eq('session_id', sessionId)
          .eq('is_deleted', false)
          .order('timestamp', { ascending: true });
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        if (limit) query = query.limit(limit);
        const { data, error } = await query;
        if (error) throw error;
        const messages = (data || []).map((m: any) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          toolCalls: m.tool_calls || [],
        }));
        res.json({ success: true, data: messages });
        return;
      }
      // 内存降级（最后兜底）
      const messages = (sessionMessages.get(sessionId) || []).map(m => ({
        ...m,
        toolCalls: [],
      }));
      res.json({ success: true, data: messages });
    } catch (error) {
      logger.error('GET /api/sessions/:id/messages failed:', error);
      res.json({ success: false, error: { code: 'DB_ERROR', message: formatError(error) } });
    }
  });

  router.delete('/sessions/:id', async (req: Request, res: Response) => {
    try {
      const sessionId = req.params.id as string;
      const sm = await tryGetSessionManager();
      if (sm) {
        await sm.deleteSession(sessionId);
      } else {
        // Supabase 降级：软删除（设置 is_deleted = true）
        const sb = await getSupabaseForSession();
        if (sb) {
          const now = Date.now();
          await sb.supabase.from('sessions').update({ is_deleted: true, updated_at: now }).eq('id', sessionId).eq('user_id', sb.userId);
          await sb.supabase.from('messages').update({ is_deleted: true, updated_at: now }).eq('session_id', sessionId).eq('user_id', sb.userId);
        }
      }
      inMemorySessions.delete(sessionId);
      sessionMessages.delete(sessionId);
      res.json({ success: true, data: null });
    } catch (error) {
      logger.error('DELETE /api/sessions/:id failed:', error);
      res.json({ success: false, error: { code: 'DB_ERROR', message: formatError(error) } });
    }
  });

  router.post('/sessions/:id/archive', async (req: Request, res: Response) => {
    try {
      const sessionId = req.params.id as string;
      const sm = await tryGetSessionManager();
      if (sm) {
        const result = await sm.archiveSession(sessionId);
        res.json({ success: true, data: result });
        return;
      }
      // Supabase 降级：无 is_archived 列，直接返回成功
      const sb = await getSupabaseForSession();
      if (sb) {
        res.json({ success: true, data: null });
        return;
      }
      // 内存降级（最后兜底）
      const session = inMemorySessions.get(sessionId);
      if (session) {
        session.isArchived = true;
        session.archivedAt = Date.now();
      }
      res.json({ success: true, data: session || null });
    } catch (error) {
      logger.error('POST /api/sessions/:id/archive failed:', error);
      res.json({ success: false, error: { code: 'DB_ERROR', message: formatError(error) } });
    }
  });

  router.post('/sessions/:id/unarchive', async (req: Request, res: Response) => {
    try {
      const sessionId = req.params.id as string;
      const sm = await tryGetSessionManager();
      if (sm) {
        const result = await sm.unarchiveSession(sessionId);
        res.json({ success: true, data: result });
        return;
      }
      // Supabase 降级：无 is_archived 列，直接返回成功
      const sb = await getSupabaseForSession();
      if (sb) {
        res.json({ success: true, data: null });
        return;
      }
      // 内存降级（最后兜底）
      const session = inMemorySessions.get(sessionId);
      if (session) {
        session.isArchived = false;
        session.archivedAt = undefined;
      }
      res.json({ success: true, data: session || null });
    } catch (error) {
      logger.error('POST /api/sessions/:id/unarchive failed:', error);
      res.json({ success: false, error: { code: 'DB_ERROR', message: formatError(error) } });
    }
  });

  return router;
}
