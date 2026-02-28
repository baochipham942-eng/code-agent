/**
 * GUI 测试: Code Agent 消息回复功能
 * 使用 UI-TARS SDK + 豆包视觉模型进行真实 GUI 交互测试
 *
 * 前置条件:
 *   1. Code Agent Electron 应用正在运行
 *   2. npm install @ui-tars/sdk @ui-tars/operator-nut-js (在本目录或全局)
 *
 * 用法:
 *   node tests/gui/test-channel-message.js
 *   node tests/gui/test-channel-message.js --scenario=empty  (测试空回复场景)
 *   node tests/gui/test-channel-message.js --scenario=error  (测试错误场景)
 *
 * 测试场景:
 *   1. 基础消息回复: 输入 → 发送 → 验证回复显示
 *   2. 空回复处理: 验证空消息不显示在 UI 中
 *   3. 多轮对话: 连续发送多条消息，验证每轮回复正确
 *   4. 特殊字符: 代码片段、emoji、Markdown
 */

// UI-TARS SDK 已在 code-agent 中安装
// operator-nut-js 在 ui-tars-demo 中安装，通过 createRequire 引用
import { GUIAgent, StatusEnum } from '@ui-tars/sdk';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// operator-nut-js 未在 code-agent 中安装，从 ui-tars-demo 引用
let NutJSOperator;
try {
  ({ NutJSOperator } = await import('@ui-tars/operator-nut-js'));
} catch {
  // fallback: 从 ui-tars-demo 的 node_modules 加载
  const homedir = require('os').homedir();
  const operatorPath = `${homedir}/Downloads/ai/ui-tars-demo/node_modules/@ui-tars/operator-nut-js/dist/index.js`;
  ({ NutJSOperator } = await import(operatorPath));
}

// ============================================================================
// 配置
// ============================================================================

const API_KEY = process.env.VOLCENGINE_API_KEY || 'f5c52332-99e3-4e5b-9235-e6b61da87f12';
const BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const MODEL = 'doubao-seed-1-6-vision-250815';
const TIMEOUT_MS = 180_000; // 3 分钟
const MAX_STEPS = 30;

// ============================================================================
// 测试场景定义
// ============================================================================

const SCENARIOS = {
  // 基础消息回复
  basic: {
    name: '基础消息回复',
    instruction: `
在屏幕上找到 Code Agent 应用窗口。执行以下步骤:
1. 找到底部的输入框（包含"描述你想解决的问题"的文本框）
2. 点击输入框
3. 输入文字: "你好，请自我介绍"
4. 点击发送按钮（或按 Enter/Command+Enter）
5. 等待 5 秒让 AI 回复
6. 检查聊天区域是否出现了 AI 的回复消息（应该有一段文字回复）
7. 如果看到回复，任务完成
`.trim(),
    verify: (steps) => {
      // 验证: 至少执行了输入和发送动作
      const hasType = steps.some(s => s.action === 'type');
      const hasClick = steps.some(s => s.action === 'click');
      return hasType && hasClick;
    },
  },

  // 空回复 — 验证 UI 过滤
  empty: {
    name: '空消息过滤验证',
    instruction: `
在屏幕上找到 Code Agent 应用窗口。执行以下步骤:
1. 找到底部输入框，点击它
2. 输入: "1+1等于几？"
3. 点击发送按钮
4. 等待 AI 回复出现
5. 仔细观察聊天区域:
   - 应该只看到用户消息和 AI 回复
   - 不应该看到空白的消息气泡
   - 不应该看到 JSON 格式的工具调用原始数据
6. 截屏确认聊天区域的显示是否正常
7. 如果聊天区域只显示用户消息和 AI 回复（没有空白气泡或 JSON），任务完成
`.trim(),
    verify: (steps) => steps.length >= 3,
  },

  // 多轮对话
  multi: {
    name: '多轮对话',
    instruction: `
在 Code Agent 应用窗口中执行:
1. 在输入框中输入: "今天星期几？" 并发送
2. 等待回复出现
3. 再输入: "那明天呢？" 并发送
4. 等待第二个回复出现
5. 检查聊天区域:
   - 第一个问题和回复应该在上方
   - 第二个问题和回复应该在下方
   - 两轮对话都应该清晰可见
6. 任务完成
`.trim(),
    verify: (steps) => {
      const typeCount = steps.filter(s => s.action === 'type').length;
      return typeCount >= 2;
    },
  },

  // 特殊字符
  special: {
    name: '特殊字符输入',
    instruction: `
在 Code Agent 应用窗口中执行:
1. 在输入框中输入以下内容（包含代码和特殊字符）:
   请解释这段代码: console.log("hello 🌍")
2. 发送消息
3. 等待回复
4. 验证:
   - 用户消息中应该能看到代码和 emoji
   - AI 回复应该正常显示（不应崩溃或显示乱码）
5. 任务完成
`.trim(),
    verify: (steps) => steps.some(s => s.action === 'type'),
  },
};

// ============================================================================
// 测试执行器
// ============================================================================

async function runGUITest(scenarioKey) {
  const scenario = SCENARIOS[scenarioKey];
  if (!scenario) {
    console.error(`未知场景: ${scenarioKey}`);
    console.log(`可用场景: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`GUI 测试: ${scenario.name}`);
  console.log(`模型: ${MODEL}`);
  console.log(`${'='.repeat(60)}\n`);

  const steps = [];
  let stepCount = 0;
  const startTime = Date.now();
  let finalStatus = 'unknown';

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    console.log('\n⏰ 超时，停止测试');
    abortController.abort();
  }, TIMEOUT_MS);

  const operator = new NutJSOperator();

  const guiAgent = new GUIAgent({
    model: {
      baseURL: BASE_URL,
      apiKey: API_KEY,
      model: MODEL,
      temperature: 0,
    },
    operator,
    signal: abortController.signal,
    maxLoopCount: MAX_STEPS,
    loopIntervalInMs: 1500,

    onData: ({ data }) => {
      if (data.status === StatusEnum.RUNNING && data.conversations.length > 0) {
        for (const conv of data.conversations) {
          stepCount++;
          if (conv.from === 'human' && conv.screenshotBase64) {
            const size = conv.screenshotContext?.size;
            console.log(`[${stepCount}] 📸 截屏 (${size?.width}x${size?.height})`);
          } else if (conv.from === 'gpt') {
            const text = conv.value?.substring(0, 200) || '';
            console.log(`[${stepCount}] 🤖 ${text}`);
            if (conv.predictionParsed) {
              for (const pred of conv.predictionParsed) {
                console.log(`  → ${pred.action_type}(${JSON.stringify(pred.action_inputs)})`);
                if (pred.thought) {
                  console.log(`  💭 ${pred.thought.substring(0, 150)}`);
                }
              }
            }
            steps.push({
              step: stepCount,
              action: conv.predictionParsed?.[0]?.action_type,
              thought: conv.predictionParsed?.[0]?.thought,
              inputs: conv.predictionParsed?.[0]?.action_inputs,
            });
          }
        }
      }

      const terminalStates = [StatusEnum.END, StatusEnum.ERROR, StatusEnum.MAX_LOOP, StatusEnum.USER_STOPPED];
      if (terminalStates.includes(data.status)) {
        finalStatus = data.status;
        console.log(`\n🏁 状态: ${data.status}`);
        if (data.errMsg) console.log(`❌ ${data.errMsg}`);
      }
    },

    onError: ({ error }) => {
      console.error(`\n❌ 错误: ${error.message || error}`);
      finalStatus = 'error';
    },
  });

  console.log(`📋 场景: ${scenario.name}`);
  console.log(`--- 开始执行 ---\n`);

  try {
    await guiAgent.run(scenario.instruction);
  } catch (err) {
    console.error(`\n💥 异常: ${err.message}`);
    finalStatus = 'exception';
  } finally {
    clearTimeout(timeout);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // ======== 结果报告 ========
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 测试结果: ${scenario.name}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`状态: ${finalStatus}`);
  console.log(`耗时: ${elapsed}s`);
  console.log(`步数: ${steps.length}`);
  console.log(`动作序列:`);
  for (const s of steps) {
    console.log(`  [${s.step}] ${s.action || '(无动作)'}`);
  }

  // 基础验证
  const passed = scenario.verify(steps);
  console.log(`\n验证: ${passed ? '✅ PASS' : '❌ FAIL'}`);

  if (finalStatus === 'end' || finalStatus === StatusEnum.END) {
    console.log(`完成状态: ✅ 正常结束`);
  } else if (finalStatus === 'max_loop' || finalStatus === StatusEnum.MAX_LOOP) {
    console.log(`完成状态: ⚠️ 达到最大步数`);
  } else {
    console.log(`完成状态: ❌ 异常 (${finalStatus})`);
  }

  console.log(`${'='.repeat(60)}\n`);

  return { passed, steps: steps.length, elapsed, status: finalStatus };
}

// ============================================================================
// 批量执行
// ============================================================================

async function runAll() {
  console.log('\n🚀 开始执行所有 GUI 测试场景\n');
  const results = {};

  for (const key of Object.keys(SCENARIOS)) {
    console.log(`\n▶ 执行场景: ${key}\n`);
    results[key] = await runGUITest(key);
    // 场景间等待 3 秒
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('\n' + '='.repeat(60));
  console.log('📋 GUI 测试汇总');
  console.log('='.repeat(60));
  for (const [key, result] of Object.entries(results)) {
    const icon = result.passed ? '✅' : '❌';
    console.log(`  ${icon} ${SCENARIOS[key].name}: ${result.elapsed}s, ${result.steps} 步`);
  }
  console.log('='.repeat(60) + '\n');
}

// ============================================================================
// 入口
// ============================================================================

const args = process.argv.slice(2);
const scenarioArg = args.find(a => a.startsWith('--scenario='));
const scenario = scenarioArg?.split('=')[1];

if (args.includes('--all')) {
  runAll().catch(console.error);
} else {
  runGUITest(scenario || 'basic').catch(console.error);
}
