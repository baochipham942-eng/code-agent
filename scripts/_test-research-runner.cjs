/**
 * Deep Research E2E 测试运行器
 *
 * 用法: node scripts/_test-research-runner.cjs [topic]
 * 示例: HTTPS_PROXY=http://127.0.0.1:7897 node scripts/_test-research-runner.cjs "AI Agent 框架对比"
 *
 * 前置条件: dist/test-research.cjs 已通过 test-deep-research.sh 构建
 */

'use strict';

// Skip keytar (native binding causes SIGSEGV outside Electron)
process.env.CODE_AGENT_CLI_MODE = '1';

// No separate dotenv needed — ConfigService in the bundle loads .env automatically.
// Just ensure we're running from the project root so relative .env resolution works.
const path = require('path');
process.chdir(path.join(__dirname, '..'));

// Load bundle (electron-mock is already baked in by esbuild)
const bundle = require('../dist/test-research.cjs');

async function main() {
  const topic = process.argv[2] || 'MCP 协议最新进展';

  try {
    // --- Initialize dependencies ---
    const modelRouter = new bundle.ModelRouter();
    const toolRegistry = new bundle.ToolRegistry();
    const toolExecutor = new bundle.ToolExecutor({
      toolRegistry,
      requestPermission: async () => true, // auto-approve for testing
      workingDirectory: process.cwd(),
    });

    // --- Event handler ---
    const events = [];
    const onEvent = (event) => {
      events.push({ ...event, timestamp: Date.now() });
      if (event.type === 'research_progress') {
        const d = event.data;
        const line = `[${d.phase || '?'}] ${d.percent ?? '?'}% - ${d.message || ''}`;
        process.stdout.write(`\r${line.padEnd(100)}`);
      }
    };

    // --- Create and run ---
    const dr = new bundle.DeepResearchMode({ modelRouter, toolExecutor, onEvent });

    console.log(`Topic: ${topic}`);
    console.log('Config: enableReflection=true, maxReflectionRounds=1, enableUrlCompression=true');
    console.log('');

    const result = await dr.run(topic, 'default', {
      enableReflection: true,
      maxReflectionRounds: 1,
      enableUrlCompression: true,
      enableMemory: false,
    });

    // --- Print results ---
    console.log('\n');
    console.log('='.repeat(60));
    console.log('RESULTS');
    console.log('='.repeat(60));
    console.log(`Status: ${result.success ? 'SUCCESS' : 'FAILED'}`);
    console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);
    console.log(`Events captured: ${events.length}`);

    if (result.error) {
      console.log(`Error: ${result.error}`);
      process.exit(1);
    }

    const report = result.report;
    if (!report) {
      console.log('No report generated');
      process.exit(1);
    }

    console.log(`Report length: ${report.content.length} chars`);
    console.log(`Sources: ${(report.sources || []).length}`);

    // --- Citation quality analysis ---
    const rawUrls = (report.content.match(/https?:\/\/[^\s\])<>"')\u{FF09}]+/gu) || []);
    const mdLinks = (report.content.match(/\]\(https?:\/\/[^\s)]+\)/g) || []);
    const bareUrls = rawUrls.length - mdLinks.length;

    console.log('');
    console.log('--- Citation Quality ---');
    console.log(`Markdown links: ${mdLinks.length}`);
    console.log(`Bare URLs: ${bareUrls}`);
    console.log(`[src:N] markers: ${(report.content.match(/\[src:?\d+\]/g) || []).length}`);

    // --- Research steps ---
    if (result.plan) {
      const steps = result.plan.steps || [];
      const completed = steps.filter((s) => s.status === 'completed').length;
      const failed = steps.filter((s) => s.status === 'failed').length;
      console.log('');
      console.log('--- Research Steps ---');
      console.log(`Total: ${steps.length}, Completed: ${completed}, Failed: ${failed}`);
    }

    // --- Report preview ---
    console.log('');
    console.log('--- Report Preview (first 2000 chars) ---');
    console.log(report.content.substring(0, 2000));
    console.log('...');

    // --- Truncation check ---
    const lastChars = report.content.slice(-100);
    const seemsTruncated =
      !lastChars.includes('。') &&
      !lastChars.includes('Sources') &&
      !lastChars.includes('参考') &&
      !lastChars.includes('\n');
    console.log('');
    console.log(`Seems truncated: ${seemsTruncated}`);
    console.log(`Last 100 chars: ${lastChars}`);

    // --- Summary ---
    console.log('');
    console.log('='.repeat(60));
    console.log(result.success ? 'PASS' : 'FAIL');
    console.log('='.repeat(60));
  } catch (err) {
    console.error('\nFAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
