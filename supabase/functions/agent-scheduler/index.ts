// ============================================================================
// Agent Scheduler - Supabase Edge Function
// 云端 Agent 任务调度器
// ============================================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  decrypt,
  encrypt,
  loadKeysFromEnv,
  validateEncryptedPayload,
  type EncryptedPayload,
} from '../shared/crypto.ts';
import {
  getAgentConfig,
  isValidAgentType,
  getToolsForAgent,
  type CloudAgentType,
} from '../shared/agents.ts';

// ============================================================================
// 类型定义
// ============================================================================

interface TaskRecord {
  id: string;
  user_id: string;
  type: CloudAgentType;
  encrypted_prompt: EncryptedPayload | null;
  encryption_key_id: string | null;
  max_iterations: number;
  timeout_ms: number;
  metadata: Record<string, unknown>;
}

interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  iterations: number;
  toolsUsed: string[];
}

// ============================================================================
// 环境变量
// ============================================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const LLM_API_KEY = Deno.env.get('LLM_API_KEY') || Deno.env.get('DEEPSEEK_API_KEY')!;
const LLM_API_URL = Deno.env.get('LLM_API_URL') || 'https://api.deepseek.com/v1/chat/completions';

// Worker 标识
const WORKER_ID = `worker_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// ============================================================================
// Supabase 客户端
// ============================================================================

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ============================================================================
// 任务执行
// ============================================================================

/**
 * 执行 Agent 任务
 */
async function executeTask(task: TaskRecord): Promise<ExecutionResult> {
  const startTime = Date.now();
  const toolsUsed: string[] = [];
  let iterations = 0;

  try {
    // 获取 Agent 配置
    const agentConfig = getAgentConfig(task.type);

    // 解密 prompt
    let prompt = '';
    if (task.encrypted_prompt && task.encryption_key_id) {
      if (validateEncryptedPayload(task.encrypted_prompt)) {
        prompt = await decrypt(task.encrypted_prompt, task.encryption_key_id);
      } else {
        throw new Error('Invalid encrypted prompt format');
      }
    }

    if (!prompt) {
      throw new Error('No prompt provided');
    }

    // 获取可用工具
    const tools = getToolsForAgent(task.type);

    // 构建消息
    const messages = [
      {
        role: 'system',
        content: agentConfig.systemPrompt,
      },
      {
        role: 'user',
        content: prompt,
      },
    ];

    // 执行循环
    const maxIterations = Math.min(task.max_iterations, agentConfig.maxIterations);
    const timeout = Math.min(task.timeout_ms, agentConfig.timeout);
    const deadline = startTime + timeout;

    let finalOutput = '';
    let isComplete = false;

    while (iterations < maxIterations && !isComplete && Date.now() < deadline) {
      iterations++;

      // 更新进度
      await updateTaskProgress(task.id, {
        progress: Math.round((iterations / maxIterations) * 80),
        currentStep: `Iteration ${iterations}/${maxIterations}`,
      });

      // 调用 LLM
      const response = await callLLM(messages, tools);

      if (!response.success) {
        throw new Error(response.error || 'LLM call failed');
      }

      const assistantMessage = response.message;
      messages.push(assistantMessage);

      // 检查是否有工具调用
      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        for (const toolCall of assistantMessage.tool_calls) {
          const toolName = toolCall.function.name;
          toolsUsed.push(toolName);

          // 执行工具（简化版）
          const toolResult = await executeCloudTool(
            toolName,
            JSON.parse(toolCall.function.arguments),
            prompt
          );

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult,
          });
        }
      } else {
        // 没有工具调用，认为任务完成
        finalOutput = assistantMessage.content || '';
        isComplete = true;
      }
    }

    // 如果没有完成但达到了限制，使用最后的输出
    if (!isComplete && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.role === 'assistant' && lastMessage.content) {
        finalOutput = lastMessage.content;
      }
    }

    return {
      success: true,
      output: finalOutput,
      iterations,
      toolsUsed: [...new Set(toolsUsed)],
    };
  } catch (error) {
    return {
      success: false,
      output: '',
      error: error instanceof Error ? error.message : 'Unknown error',
      iterations,
      toolsUsed: [...new Set(toolsUsed)],
    };
  }
}

/**
 * 调用 LLM API
 */
async function callLLM(
  messages: unknown[],
  tools: unknown[]
): Promise<{
  success: boolean;
  message?: Record<string, unknown>;
  error?: string;
}> {
  try {
    const response = await fetch(LLM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages,
        tools: tools.length > 0 ? tools.map((t) => ({ type: 'function', function: t })) : undefined,
        max_tokens: 4096,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `LLM API error: ${response.status} - ${errorText}` };
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;

    if (!message) {
      return { success: false, error: 'No message in response' };
    }

    return { success: true, message };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * 执行云端工具（简化版）
 */
async function executeCloudTool(
  name: string,
  args: Record<string, unknown>,
  context: string
): Promise<string> {
  switch (name) {
    case 'think':
      return `Thought recorded: ${args.thought}`;

    case 'search_context':
      // 简单的上下文搜索
      const query = (args.query as string).toLowerCase();
      const lines = context.split('\n');
      const matches = lines.filter((line) => line.toLowerCase().includes(query));
      return matches.length > 0
        ? `Found ${matches.length} matches:\n${matches.slice(0, 5).join('\n')}`
        : 'No matches found in context';

    case 'summarize':
      const content = args.content as string;
      const maxLength = (args.maxLength as number) || 500;
      // 简单的摘要（实际应该调用 LLM）
      return content.length > maxLength
        ? content.substring(0, maxLength) + '...'
        : content;

    case 'create_outline':
      const topic = args.topic as string;
      const sections = (args.sections as string[]) || [];
      return `# Outline: ${topic}\n\n${sections.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;

    case 'analyze_code':
      const code = args.code as string;
      const aspects = (args.aspects as string[]) || ['general'];
      return `Code Analysis (${aspects.join(', ')}):\n- Lines: ${code.split('\n').length}\n- Characters: ${code.length}`;

    default:
      return `Unknown tool: ${name}`;
  }
}

/**
 * 更新任务进度
 */
async function updateTaskProgress(
  taskId: string,
  update: { progress?: number; currentStep?: string }
): Promise<void> {
  const { error } = await supabase
    .from('cloud_tasks')
    .update({
      progress: update.progress,
      current_step: update.currentStep,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskId);

  if (error) {
    console.error(`[Scheduler] Failed to update progress for ${taskId}:`, error);
  }

  // 写入日志
  await supabase.from('cloud_task_logs').insert({
    task_id: taskId,
    log_type: 'progress',
    progress: update.progress,
    current_step: update.currentStep,
    message: `Progress: ${update.progress}% - ${update.currentStep}`,
  });
}

/**
 * 完成任务
 */
async function completeTask(
  taskId: string,
  result: ExecutionResult,
  encryptionKeyId?: string
): Promise<void> {
  // 加密结果
  let encryptedResult: EncryptedPayload | undefined;
  if (result.success && result.output && encryptionKeyId) {
    try {
      encryptedResult = await encrypt(result.output, encryptionKeyId);
    } catch (error) {
      console.error(`[Scheduler] Failed to encrypt result for ${taskId}:`, error);
    }
  }

  const updateData: Record<string, unknown> = {
    status: result.success ? 'completed' : 'failed',
    progress: 100,
    current_step: result.success ? 'Completed' : 'Failed',
    error: result.error,
    encrypted_result: encryptedResult,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    metadata: {
      iterations: result.iterations,
      toolsUsed: result.toolsUsed,
      workerId: WORKER_ID,
    },
  };

  const { error } = await supabase
    .from('cloud_tasks')
    .update(updateData)
    .eq('id', taskId);

  if (error) {
    console.error(`[Scheduler] Failed to complete task ${taskId}:`, error);
  }

  // 清理队列
  await supabase.from('cloud_task_queue').delete().eq('task_id', taskId);

  // 写入完成日志
  await supabase.from('cloud_task_logs').insert({
    task_id: taskId,
    log_type: result.success ? 'output' : 'error',
    message: result.success
      ? `Task completed in ${result.iterations} iterations`
      : `Task failed: ${result.error}`,
  });
}

// ============================================================================
// 主处理函数
// ============================================================================

async function processNextTask(): Promise<{ processed: boolean; taskId?: string }> {
  // 获取下一个任务
  const { data, error } = await supabase.rpc('get_next_cloud_task', {
    p_worker_id: WORKER_ID,
  });

  if (error) {
    console.error('[Scheduler] Failed to get next task:', error);
    return { processed: false };
  }

  if (!data || data.length === 0) {
    return { processed: false };
  }

  const task = data[0] as TaskRecord;
  console.log(`[Scheduler] Processing task ${task.id} (type: ${task.type})`);

  try {
    // 验证任务类型
    if (!isValidAgentType(task.type)) {
      throw new Error(`Invalid agent type: ${task.type}`);
    }

    // 执行任务
    const result = await executeTask(task);

    // 完成任务
    await completeTask(task.id, result, task.encryption_key_id || undefined);

    console.log(
      `[Scheduler] Task ${task.id} ${result.success ? 'completed' : 'failed'}`
    );

    return { processed: true, taskId: task.id };
  } catch (error) {
    console.error(`[Scheduler] Error processing task ${task.id}:`, error);

    // 标记失败
    await completeTask(
      task.id,
      {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Unknown error',
        iterations: 0,
        toolsUsed: [],
      },
      task.encryption_key_id || undefined
    );

    return { processed: true, taskId: task.id };
  }
}

// ============================================================================
// HTTP 服务
// ============================================================================

serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS 头
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  // 处理 OPTIONS 请求
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // 加载加密密钥
    await loadKeysFromEnv();

    // 路由处理
    if (path === '/process' && req.method === 'POST') {
      // 处理单个任务
      const result = await processNextTask();
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (path === '/batch' && req.method === 'POST') {
      // 批量处理任务
      const body = await req.json();
      const maxTasks = body.maxTasks || 5;
      const results: { taskId: string; success: boolean }[] = [];

      for (let i = 0; i < maxTasks; i++) {
        const result = await processNextTask();
        if (!result.processed) break;
        if (result.taskId) {
          results.push({ taskId: result.taskId, success: true });
        }
      }

      return new Response(JSON.stringify({ processed: results.length, results }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (path === '/health' && req.method === 'GET') {
      // 健康检查
      return new Response(
        JSON.stringify({
          status: 'healthy',
          workerId: WORKER_ID,
          timestamp: new Date().toISOString(),
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (path === '/stats' && req.method === 'GET') {
      // 获取队列统计
      const { data: queueData } = await supabase
        .from('cloud_task_queue')
        .select('*', { count: 'exact', head: true })
        .is('picked_at', null);

      const { data: runningData } = await supabase
        .from('cloud_task_queue')
        .select('*', { count: 'exact', head: true })
        .not('picked_at', 'is', null);

      return new Response(
        JSON.stringify({
          workerId: WORKER_ID,
          queued: queueData?.length || 0,
          running: runningData?.length || 0,
          timestamp: new Date().toISOString(),
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 404
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[Scheduler] Error:', error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Internal error',
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
