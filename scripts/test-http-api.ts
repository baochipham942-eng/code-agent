/**
 * 测试 HTTP API 通道
 *
 * 运行: npx tsx scripts/test-http-api.ts
 */

import { ApiChannel } from '../src/main/channels/api/apiChannel';

const API_KEY = 'test-api-key-12345';
const PORT = 3100;

async function testHttpApiChannel() {
  console.log('='.repeat(60));
  console.log('HTTP API 通道测试');
  console.log('='.repeat(60));

  // 创建 API 通道实例
  const channel = new ApiChannel('test-account');

  // 监听消息事件并返回模拟响应
  channel.on('message', async (message) => {
    console.log('\n' + '='.repeat(60));
    console.log('📨 收到消息！');
    console.log('='.repeat(60));
    console.log('消息 ID:', message.id);
    console.log('发送者:', message.sender.name);
    console.log('内容:', message.content);
    console.log('时间:', new Date(message.timestamp).toLocaleString());

    // 获取响应回调并发送模拟响应
    const callback = channel.getResponseCallback(message.id);
    if (callback) {
      console.log('\n正在发送响应...');
      // 模拟 AI 响应
      const response = `你好！我是 Code Agent，一个 AI 编程助手。你发送的消息是：「${message.content}」`;
      await callback.sendText(response);
      console.log('✅ 响应已发送');
    }
  });

  channel.on('status_change', (status, error) => {
    console.log(`状态变化: ${status}${error ? ` (${error})` : ''}`);
  });

  channel.on('error', (error) => {
    console.error('错误:', error.message);
  });

  // 初始化并连接
  console.log('\n正在启动 HTTP API 服务器...');
  await channel.initialize({
    type: 'http-api',
    port: PORT,
    apiKey: API_KEY,
  });
  await channel.connect();

  console.log(`\n✅ HTTP API 服务器已启动！`);
  console.log(`\n端点信息:`);
  console.log(`  - 健康检查: http://localhost:${PORT}/health`);
  console.log(`  - 同步消息: POST http://localhost:${PORT}/api/message`);
  console.log(`  - 流式消息: POST http://localhost:${PORT}/api/message/stream`);
  console.log(`\nAPI Key: ${API_KEY}`);
  console.log(`\n测试命令:`);
  console.log(`  curl -X POST http://localhost:${PORT}/api/message \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -H "X-API-Key: ${API_KEY}" \\`);
  console.log(`    -d '{"message": "你好，请介绍一下自己"}'`);
  console.log(`\n按 Ctrl+C 退出\n`);

  // 保持运行
  process.on('SIGINT', async () => {
    console.log('\n正在关闭...');
    await channel.destroy();
    process.exit(0);
  });

  // 永久等待
  await new Promise(() => {});
}

testHttpApiChannel().catch(console.error);
