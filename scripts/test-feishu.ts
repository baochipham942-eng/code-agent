/**
 * 测试飞书通道连接
 *
 * 运行: npx tsx scripts/test-feishu.ts
 */

import * as lark from '@larksuiteoapi/node-sdk';

const APP_ID = process.env.FEISHU_TEST_APP_ID;
const APP_SECRET = process.env.FEISHU_TEST_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  console.error('请先设置环境变量 FEISHU_TEST_APP_ID 和 FEISHU_TEST_APP_SECRET');
  process.exit(1);
}

async function testFeishuConnection() {
  console.log('='.repeat(60));
  console.log('飞书 WebSocket 连接测试');
  console.log('='.repeat(60));
  console.log('\nApp ID:', APP_ID);

  // 创建事件分发器
  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      console.log('\n' + '='.repeat(60));
      console.log('📨 收到消息！');
      console.log('='.repeat(60));
      console.log(JSON.stringify(data, null, 2));
      return {};
    },
  });

  // 创建 WebSocket 客户端
  const wsClient = new lark.WSClient({
    appId: APP_ID,
    appSecret: APP_SECRET,
    eventDispatcher,
    loggerLevel: lark.LoggerLevel.info,
  });

  console.log('\n正在建立 WebSocket 连接...');
  console.log('请保持此脚本运行，然后去飞书开放平台点击「保存」按钮');
  console.log('\n等待连接建立中...\n');

  // 不用 await，让它在后台建立连接
  wsClient.start().catch(() => {
    // 忽略错误，继续保持运行
  });

  // 保持脚本运行
  console.log('脚本将持续运行，按 Ctrl+C 退出');
  console.log('如果连接成功，你会看到 "[ws] start to receive events" 日志\n');

  // 保持运行
  process.on('SIGINT', () => {
    console.log('\n正在关闭...');
    process.exit(0);
  });

  // 永久等待
  await new Promise(() => {});
}

testFeishuConnection();
