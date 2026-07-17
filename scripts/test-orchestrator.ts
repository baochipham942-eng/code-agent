#!/usr/bin/env npx ts-node
/**
 * 测试 TaskOrchestrator 的并行判断能力
 */

import { getTaskOrchestrator, resetTaskOrchestrator } from '../src/host/planning/taskOrchestrator';

// 需要设置环境变量
import * as dotenv from 'dotenv';
dotenv.config();

const testCases = [
  {
    name: '简单任务',
    message: '修复登录页面的按钮样式',
    expectParallel: false,
  },
  {
    name: '多维度审计',
    message: `对项目进行完整的安全审计和性能优化，要求：
    1. 扫描所有源代码文件，找出 SQL 注入、XSS 等安全漏洞
    2. 分析所有数据库查询，找出 N+1 问题
    3. 检查代码质量，找出所有 any 类型使用`,
    expectParallel: true,
  },
  {
    name: '串行依赖任务',
    message: '重构用户模块：先修改数据库表结构，然后更新 API，最后修改前端',
    expectParallel: false,
  },
  {
    name: '独立模块分析',
    message: '分析 auth 模块、payment 模块和 notification 模块的代码质量',
    expectParallel: true,
  },
];

async function runTests() {
  console.log('🚀 Testing TaskOrchestrator\n');
  console.log('Provider: Groq (llama-3.3-70b-versatile)\n');
  console.log('='.repeat(60));

  // 检查 API Key
  if (!process.env.GROQ_API_KEY) {
    console.error('❌ GROQ_API_KEY not set. Please set it in .env file.');
    process.exit(1);
  }

  const orchestrator = getTaskOrchestrator({
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
  });

  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    console.log(`\n📋 ${tc.name}`);
    console.log(`   Message: "${tc.message.substring(0, 50)}..."`);
    console.log(`   Expect: ${tc.expectParallel ? '✅ Parallel' : '⛔ Serial'}`);

    try {
      const startTime = Date.now();
      const judgment = await orchestrator.judge(tc.message);
      const elapsed = Date.now() - startTime;

      console.log(`   Result: ${judgment.shouldParallel ? '✅ Parallel' : '⛔ Serial'}`);
      console.log(`   Confidence: ${(judgment.confidence * 100).toFixed(0)}%`);
      console.log(`   Critical Path: ${judgment.criticalPathLength} steps`);
      console.log(`   Dimensions: ${judgment.parallelDimensions}`);
      if (judgment.suggestedDimensions) {
        console.log(`   Suggested: ${judgment.suggestedDimensions.join(', ')}`);
      }
      console.log(`   Reason: ${judgment.reason}`);
      console.log(`   Time: ${elapsed}ms`);

      const isCorrect = judgment.shouldParallel === tc.expectParallel;
      if (isCorrect) {
        console.log(`   ✅ PASS`);
        passed++;
      } else {
        console.log(`   ❌ FAIL (expected ${tc.expectParallel}, got ${judgment.shouldParallel})`);
        failed++;
      }
    } catch (error) {
      console.log(`   ❌ ERROR: ${error instanceof Error ? error.message : 'Unknown'}`);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`\n📊 Results: ${passed}/${testCases.length} passed`);
  if (failed > 0) {
    console.log(`   ${failed} failed`);
  }

  // 测试生成 hint
  console.log('\n\n📝 Sample Parallel Hint:');
  const sampleJudgment = await orchestrator.judge(testCases[1].message);
  const hint = orchestrator.generateParallelHint(sampleJudgment);
  console.log(hint || '(No hint generated)');
}

runTests().catch(console.error);
