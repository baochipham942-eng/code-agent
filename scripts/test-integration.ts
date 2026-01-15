#!/usr/bin/env node
/**
 * Integration test for Agent - calls real DeepSeek API
 * Run: npm run build:main && node scripts/test-integration.cjs
 */

import { config } from 'dotenv';
import { ModelRouter } from '../src/main/model/ModelRouter';
import type { ToolDefinition, ModelConfig } from '../src/shared/types';

// Load environment variables
config();

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

if (!DEEPSEEK_API_KEY) {
  console.error('❌ DEEPSEEK_API_KEY not found in environment');
  process.exit(1);
}

// Define test tools
const testTools: ToolDefinition[] = [
  {
    name: 'list_directory',
    description: 'List files in a directory',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: 'Read contents of a file',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'File path' },
      },
      required: ['file_path'],
    },
  },
];

const modelConfig: ModelConfig = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  apiKey: DEEPSEEK_API_KEY,
  temperature: 0.7,
  maxTokens: 1024,
};

async function testDeepSeekToolCall() {
  console.log('\n=== Integration Test: DeepSeek Tool Call ===');
  console.log('Testing if DeepSeek properly returns tool calls...\n');

  const router = new ModelRouter();

  const messages = [
    {
      role: 'system',
      content: 'You are a helpful assistant. Use the available tools when needed. Always call tools with proper JSON arguments.',
    },
    {
      role: 'user',
      content: '请列出当前目录的文件，使用 list_directory 工具',
    },
  ];

  try {
    const response = await router.inference(messages, testTools, modelConfig);

    console.log('Response type:', response.type);

    if (response.type === 'tool_use') {
      console.log('✅ DeepSeek returned tool calls properly');
      console.log('Tool calls:');
      response.toolCalls?.forEach((tc, i) => {
        console.log(`  ${i + 1}. ${tc.name}(${JSON.stringify(tc.arguments)})`);
      });
      return true;
    } else {
      console.log('Response content:', response.content?.substring(0, 200));

      // Check if it's an embedded tool call that was parsed
      if (response.content?.includes('Calling')) {
        console.log('⚠️ DeepSeek returned text with embedded tool call syntax');
        console.log('   This should have been parsed by our fix!');
        return false;
      }

      console.log('❌ DeepSeek did not return tool calls');
      return false;
    }
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
    return false;
  }
}

async function testAgentLoop() {
  console.log('\n=== Integration Test: Multi-turn Agent Loop ===');
  console.log('Simulating agent loop with tool results...\n');

  const router = new ModelRouter();

  // Turn 1: User request
  const messages: Array<{ role: string; content: string }> = [
    {
      role: 'system',
      content: 'You are a coding assistant. Use tools to help users. After using a tool, continue with more tools if needed or provide a final answer.',
    },
    {
      role: 'user',
      content: '帮我查看 package.json 文件内容',
    },
  ];

  let iteration = 0;
  const maxIterations = 5;

  while (iteration < maxIterations) {
    iteration++;
    console.log(`--- Iteration ${iteration} ---`);

    const response = await router.inference(messages, testTools, modelConfig);

    if (response.type === 'tool_use' && response.toolCalls?.length) {
      const toolCall = response.toolCalls[0];
      console.log(`Tool call: ${toolCall.name}`);

      // Simulate tool result
      const toolResult =
        toolCall.name === 'read_file'
          ? '{"name": "code-agent", "version": "0.1.0"}'
          : '[package.json, src/, node_modules/]';

      // Add assistant message with tool call
      messages.push({
        role: 'assistant',
        content: `Calling ${toolCall.name}(${JSON.stringify(toolCall.arguments)})`,
      });

      // Add tool result
      messages.push({
        role: 'user',
        content: `Tool result: ${toolResult}`,
      });

      console.log(`Tool result added, continuing loop...`);
    } else if (response.type === 'text') {
      console.log('Final response:', response.content?.substring(0, 100));
      console.log(`\n✅ Agent loop completed after ${iteration} iterations`);
      return true;
    }
  }

  console.log(`❌ Agent loop did not complete within ${maxIterations} iterations`);
  return false;
}

async function main() {
  console.log('==========================================');
  console.log('  Code Agent - Integration Tests');
  console.log('==========================================');
  console.log(`API Key: ${DEEPSEEK_API_KEY?.substring(0, 10)}...`);

  const results: boolean[] = [];

  results.push(await testDeepSeekToolCall());
  results.push(await testAgentLoop());

  const passed = results.filter((r) => r).length;
  const total = results.length;

  console.log('\n==========================================');
  console.log(`  Results: ${passed}/${total} tests passed`);
  console.log('==========================================');

  process.exit(passed === total ? 0 : 1);
}

main().catch(console.error);
