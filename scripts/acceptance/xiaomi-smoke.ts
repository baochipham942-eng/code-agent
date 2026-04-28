/**
 * 小米 MiMo Provider 冒烟测试
 * 用法: npx tsx scripts/acceptance/xiaomi-smoke.ts
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { XiaomiProvider } from '../../src/main/model/providers/xiaomiProvider';
import type { ModelMessage } from '../../src/main/model/types';
import type { ToolDefinition } from '../../src/shared/contract';

async function main() {
  const apiKey = process.env.XIAOMI_API_KEY;
  if (!apiKey) {
    console.error('❌ XIAOMI_API_KEY 未设置');
    process.exit(1);
  }

  const provider = new XiaomiProvider();

  // ── 测试 1: 普通对话 ─────────────────────
  console.log('\n=== 测试 1: 普通对话 (mimo-v2.5-pro) ===');
  const messages1: ModelMessage[] = [
    { role: 'user', content: '请用一句话回答：1+1等于几？' },
  ];
  const t1Start = Date.now();
  const r1 = await provider.inference(
    messages1,
    [],
    { provider: 'xiaomi', model: 'mimo-v2.5-pro', apiKey, maxTokens: 200 },
  );
  console.log(`✅ 响应 (${Date.now() - t1Start}ms):`, r1.content?.slice(0, 100));
  console.log('   tool_calls:', r1.toolCalls?.length || 0);
  console.log('   usage:', r1.usage);

  // ── 测试 2: tool calling ─────────────────────
  console.log('\n=== 测试 2: tool calling (mimo-v2.5-pro) ===');
  const tools: ToolDefinition[] = [
    {
      name: 'get_weather',
      description: 'Get current weather for a city',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      requiresPermission: false,
      permissionLevel: 'read',
    },
  ];
  const messages2: ModelMessage[] = [
    { role: 'user', content: '上海现在天气怎么样？' },
  ];
  const t2Start = Date.now();
  const r2 = await provider.inference(
    messages2,
    tools,
    { provider: 'xiaomi', model: 'mimo-v2.5-pro', apiKey, maxTokens: 400 },
  );
  console.log(`✅ 响应 (${Date.now() - t2Start}ms): tool_calls=${r2.toolCalls?.length || 0}`);
  if (r2.toolCalls?.[0]) {
    console.log('   tool name:', r2.toolCalls[0].name);
    console.log('   tool args:', JSON.stringify(r2.toolCalls[0].arguments));
  }
  console.log('   usage:', r2.usage);

  // ── 测试 3: 标准模型 mimo-v2.5 ─────────────────────
  console.log('\n=== 测试 3: 标准模型 (mimo-v2.5) ===');
  const t3Start = Date.now();
  const r3 = await provider.inference(
    [{ role: 'user', content: 'Say hi briefly.' }],
    [],
    { provider: 'xiaomi', model: 'mimo-v2.5', apiKey, maxTokens: 200 },
  );
  console.log(`✅ 响应 (${Date.now() - t3Start}ms):`, r3.content?.slice(0, 60));
  console.log('   usage:', r3.usage);

  console.log('\n🎉 所有冒烟测试通过');
}

main().catch((err) => {
  console.error('❌ 冒烟测试失败:', err);
  process.exit(1);
});
