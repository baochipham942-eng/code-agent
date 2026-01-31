#!/usr/bin/env npx tsx
/**
 * 实验：对比不同模型的多Agent自主编排能力
 *
 * 假设：KIMI K2.5 经过 PARL 训练，应该能自主进行并行编排
 * 对照：DeepSeek、GLM-4.7 可能需要外部指挥家
 *
 * 实验方法：
 * 1. 不使用外部 TaskOrchestrator
 * 2. 给同一个复杂任务
 * 3. 观察模型是否主动使用 task 工具
 */

import * as dotenv from 'dotenv';
dotenv.config();

// 实验任务（复杂度适中，适合多Agent协作）
// 关键：不明确说"使用task工具"，看模型是否自主决定
const EXPERIMENT_TASK = `对这个项目进行完整的代码审计，包括：

1. **安全审计**：扫描所有 API 端点，检查认证授权机制
2. **性能分析**：分析数据库查询，找出 N+1 问题
3. **代码质量**：检查 TypeScript any 类型使用

项目路径：/Users/linchen/Downloads/ai/code-agent
请高效完成这个任务。`;

// 模型配置
interface ModelConfig {
  name: string;
  provider: string;
  model: string;
  apiKeyEnv: string;
  endpoint: string;
}

const MODELS: ModelConfig[] = [
  {
    name: 'KIMI K2.5',
    provider: 'moonshot',
    model: 'moonshot-v1-auto', // 或 kimi-k2.5 如果有
    apiKeyEnv: 'MOONSHOT_API_KEY',
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
  },
  {
    name: 'DeepSeek Chat',
    provider: 'deepseek',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
  },
  {
    name: 'GLM-4.7',
    provider: 'zhipu',
    model: 'glm-4.7', // Coding 套餐专属模型
    apiKeyEnv: 'ZHIPU_API_KEY',
    endpoint: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
  },
];

// task 工具定义（简化版，只看模型是否调用）
const TASK_TOOL = {
  type: 'function',
  function: {
    name: 'task',
    description: '派发子代理执行特定任务。用于将复杂任务分解为子任务并行处理。',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: '子任务的简短描述',
        },
        prompt: {
          type: 'string',
          description: '给子代理的详细指令',
        },
        agent_type: {
          type: 'string',
          enum: ['explore', 'code-review', 'bash', 'execute'],
          description: '子代理类型',
        },
      },
      required: ['description', 'prompt'],
    },
  },
};

// 简化的系统提示（中立描述，不引导使用 task）
const SYSTEM_PROMPT = `你是一个代码助手。你可以使用以下工具：

- task: 派发子代理执行子任务
- read_file: 读取文件内容
- grep: 搜索代码
- glob: 查找文件

请根据任务需要选择合适的工具。`;

async function callModel(config: ModelConfig, messages: any[], tools: any[]): Promise<any> {
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) {
    return { error: `${config.apiKeyEnv} not set` };
  }

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        tools,
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return { error: `API error: ${response.status} - ${error.substring(0, 200)}` };
    }

    return await response.json();
  } catch (error) {
    return { error: `Request failed: ${error instanceof Error ? error.message : 'Unknown'}` };
  }
}

function analyzeResponse(response: any): {
  usedTaskTool: boolean;
  taskCallCount: number;
  reasoning: string;
} {
  if (response.error) {
    return { usedTaskTool: false, taskCallCount: 0, reasoning: response.error };
  }

  const choice = response.choices?.[0];
  if (!choice) {
    return { usedTaskTool: false, taskCallCount: 0, reasoning: 'No choice in response' };
  }

  const toolCalls = choice.message?.tool_calls || [];
  const taskCalls = toolCalls.filter((tc: any) => tc.function?.name === 'task');

  const content = choice.message?.content || '';
  const reasoning = content.substring(0, 300) + (content.length > 300 ? '...' : '');

  return {
    usedTaskTool: taskCalls.length > 0,
    taskCallCount: taskCalls.length,
    reasoning,
  };
}

async function runExperiment() {
  console.log('🧪 多Agent自主编排能力实验\n');
  console.log('='.repeat(70));
  console.log('\n📝 实验任务:');
  console.log(EXPERIMENT_TASK.substring(0, 200) + '...\n');
  console.log('='.repeat(70));

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: EXPERIMENT_TASK },
  ];

  const tools = [TASK_TOOL];

  const results: { model: string; used: boolean; count: number; reasoning: string }[] = [];

  for (const config of MODELS) {
    console.log(`\n🤖 Testing: ${config.name}`);
    console.log(`   Model: ${config.model}`);

    const startTime = Date.now();
    const response = await callModel(config, messages, tools);
    const elapsed = Date.now() - startTime;

    const analysis = analyzeResponse(response);

    console.log(`   Time: ${elapsed}ms`);
    console.log(`   Used task tool: ${analysis.usedTaskTool ? '✅ YES' : '❌ NO'}`);
    console.log(`   Task calls: ${analysis.taskCallCount}`);
    console.log(`   Reasoning: ${analysis.reasoning.substring(0, 100)}...`);

    results.push({
      model: config.name,
      used: analysis.usedTaskTool,
      count: analysis.taskCallCount,
      reasoning: analysis.reasoning,
    });
  }

  // 结果汇总
  console.log('\n\n' + '='.repeat(70));
  console.log('📊 实验结果汇总\n');

  console.log('| 模型 | 使用 task 工具 | 调用次数 |');
  console.log('|------|---------------|---------|');
  for (const r of results) {
    console.log(`| ${r.model.padEnd(15)} | ${r.used ? '✅ 是' : '❌ 否'}         | ${r.count}       |`);
  }

  console.log('\n📈 结论:');
  const usedTask = results.filter(r => r.used);
  if (usedTask.length === 0) {
    console.log('   所有模型都没有主动使用 task 工具');
    console.log('   → 验证了需要外部指挥家的假设');
  } else if (usedTask.length === results.length) {
    console.log('   所有模型都主动使用了 task 工具');
    console.log('   → 可能是 prompt 设计足够明确');
  } else {
    console.log('   部分模型使用了 task 工具:');
    for (const r of usedTask) {
      console.log(`   - ${r.model}: ${r.count} 次调用`);
    }
  }
}

// 检查环境变量
function checkApiKeys() {
  const missing: string[] = [];
  for (const config of MODELS) {
    if (!process.env[config.apiKeyEnv]) {
      missing.push(config.apiKeyEnv);
    }
  }
  if (missing.length > 0) {
    console.log('⚠️  缺少 API Key:');
    for (const key of missing) {
      console.log(`   - ${key}`);
    }
    console.log('\n只会测试有 API Key 的模型\n');
  }
}

checkApiKeys();
runExperiment().catch(console.error);
