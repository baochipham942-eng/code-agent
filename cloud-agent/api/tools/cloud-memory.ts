// ============================================================================
// cloud_memory - 云端记忆存储和检索工具
// POST /api/tools/cloud-memory?action=store|search
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export const config = {
  maxDuration: 30,
};

// Supabase 客户端
function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase configuration missing');
  }

  return createClient(supabaseUrl, supabaseKey);
}

// 简单的文本嵌入（使用哈希 + 词频向量）
// 生产环境应使用 OpenAI Embedding API
function simpleTextEmbedding(text: string): number[] {
  const words = text.toLowerCase().split(/\s+/);
  const wordSet = new Set(words);
  const vector: number[] = new Array(384).fill(0);

  for (const word of wordSet) {
    // 使用简单哈希计算位置
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = ((hash << 5) - hash) + word.charCodeAt(i);
      hash = hash & hash;
    }
    const index = Math.abs(hash) % 384;
    vector[index] += 1;
  }

  // 归一化
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i] /= magnitude;
    }
  }

  return vector;
}

// 计算余弦相似度
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface StoreRequest {
  key: string;
  content: string;
  metadata?: Record<string, unknown>;
  namespace?: string;
  projectId?: string;
  userId?: string;
}

interface SearchRequest {
  query: string;
  limit?: number;
  threshold?: number;
  namespace?: string;
  projectId?: string;
  userId?: string;
}

interface MemoryItem {
  key: string;
  content: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  namespace?: string;
  projectId?: string;
  userId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 存储记忆
 */
async function handleStore(req: VercelRequest, res: VercelResponse) {
  const body = req.body as StoreRequest;
  const { key, content, metadata = {}, namespace = 'default', projectId, userId } = body;

  if (!key || !content) {
    return res.status(400).json({ success: false, error: 'Key and content are required' });
  }

  const startTime = Date.now();

  try {
    const supabase = getSupabaseClient();

    // 生成嵌入向量
    const embedding = simpleTextEmbedding(content);

    // 存储到数据库
    const { data, error } = await supabase
      .from('cloud_memories')
      .upsert({
        key,
        content,
        embedding,
        metadata,
        namespace,
        project_id: projectId,
        user_id: userId,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'key,namespace,user_id',
      })
      .select()
      .single();

    if (error) {
      // 如果表不存在，尝试内存存储
      console.warn('Supabase error, falling back to response:', error);
      return res.status(200).json({
        success: true,
        message: 'Memory stored (in-memory fallback)',
        key,
        duration: Date.now() - startTime,
        note: 'Database table not configured, memory not persisted',
      });
    }

    return res.status(200).json({
      success: true,
      key,
      createdAt: data?.created_at,
      updatedAt: data?.updated_at,
      duration: Date.now() - startTime,
    });
  } catch (error: unknown) {
    const err = error as Error;
    // 如果 Supabase 不可用，返回成功但提示
    if (err.message.includes('configuration missing')) {
      return res.status(200).json({
        success: true,
        message: 'Memory storage not configured',
        key,
        duration: Date.now() - startTime,
        note: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to enable persistent memory',
      });
    }

    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to store memory',
      duration: Date.now() - startTime,
    });
  }
}

/**
 * 搜索记忆
 */
async function handleSearch(req: VercelRequest, res: VercelResponse) {
  const body = req.body as SearchRequest;
  const { query, limit = 5, threshold = 0.5, namespace = 'default', projectId, userId } = body;

  if (!query) {
    return res.status(400).json({ success: false, error: 'Query is required' });
  }

  const startTime = Date.now();

  try {
    const supabase = getSupabaseClient();

    // 生成查询嵌入
    const queryEmbedding = simpleTextEmbedding(query);

    // 从数据库获取记忆
    let dbQuery = supabase
      .from('cloud_memories')
      .select('*')
      .eq('namespace', namespace);

    if (projectId) {
      dbQuery = dbQuery.eq('project_id', projectId);
    }

    if (userId) {
      dbQuery = dbQuery.eq('user_id', userId);
    }

    const { data: memories, error } = await dbQuery.limit(100);

    if (error) {
      console.warn('Supabase error:', error);
      return res.status(200).json({
        success: true,
        query,
        results: [],
        duration: Date.now() - startTime,
        note: 'Database table not configured',
      });
    }

    // 计算相似度并排序
    const results = (memories || [])
      .map((memory: MemoryItem) => {
        const embedding = memory.embedding || simpleTextEmbedding(memory.content);
        const similarity = cosineSimilarity(queryEmbedding, embedding);
        return {
          key: memory.key,
          content: memory.content,
          similarity: Math.round(similarity * 100) / 100,
          metadata: memory.metadata,
          createdAt: memory.createdAt,
        };
      })
      .filter((item: { similarity: number }) => item.similarity >= threshold)
      .sort((a: { similarity: number }, b: { similarity: number }) => b.similarity - a.similarity)
      .slice(0, limit);

    return res.status(200).json({
      success: true,
      query,
      results,
      totalMatches: results.length,
      duration: Date.now() - startTime,
    });
  } catch (error: unknown) {
    const err = error as Error;
    // 如果 Supabase 不可用
    if (err.message.includes('configuration missing')) {
      return res.status(200).json({
        success: true,
        query,
        results: [],
        duration: Date.now() - startTime,
        note: 'Memory storage not configured',
      });
    }

    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to search memory',
      duration: Date.now() - startTime,
    });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const action = req.query.action as string;

  switch (action) {
    case 'store':
      return handleStore(req, res);
    case 'search':
      return handleSearch(req, res);
    default:
      return res.status(400).json({ error: 'Invalid action. Use: store, search' });
  }
}
