// ============================================================================
// 评测写边界的「真接线」测试 —— 不 mock ToolExecutor，走真构造 + 真 runId 一致性
// ============================================================================
// #1686 ai-review 抓出两条本可上线的病，两条都被「mock 了 ToolExecutor 的接线断言」放过：
// ① AgentLoop 不给 runId 会自己造一个，传到 executor 撞 RUN_CONTEXT_MISMATCH
//    （toolExecutor.ts:466）⇒ 评测里每次工具调用都被拒；
// ② createRunContext 会 canonicalize cwd（/tmp → /private/tmp），executor 却拿原始
//    workingDirectory ⇒ 构造期 cwd 一致性检查（toolExecutor.ts:361）直接抛。
// 所以这个文件刻意**不 mock ToolExecutor**：软链路径 + 真构造 + 真 execute，
// 让上面两条只要复发就在这里红。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { StandaloneAgentAdapter } from '../../../src/host/testing/agentAdapter';

describe('评测写边界真接线（不 mock ToolExecutor）', () => {
  let sandboxLink: string;
  let outside: string;

  beforeAll(() => { getProtocolRegistry(); });

  beforeEach(async () => {
    // 走 os.tmpdir()（macOS 上是 /var/folders/... 这类软链路径），刻意不 realpath——
    // 就是要让 workingDirectory 与 canonicalize 后的 runContext.cwd 不同字面量。
    sandboxLink = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-wire-'));
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'eval-wire-out-')));
    getToolCache().clear();
  });

  afterEach(async () => {
    await fs.rm(sandboxLink, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  function buildAdapter(): StandaloneAgentAdapter {
    return new StandaloneAgentAdapter({
      workingDirectory: sandboxLink,
      modelConfig: { provider: 'mock', model: 'mock-model' },
      requestPermission: async () => true,
    });
  }

  it('软链沙箱路径下 executor 的 cwd 与 runContext.cwd 一致（不进 errors）', async () => {
    // 🔴 判据必须落在 result.errors 上：sendMessage **不抛**，它把构造失败吞进 errors 数组。
    // 第一版写的是 `resolves.toBeDefined()` —— 撤掉 cwd 对齐它照样绿，是条瞎断言。
    const result = await buildAdapter().sendMessage('ping');
    expect(result.errors.filter((error) => /cwd mismatch/i.test(error))).toEqual([]);
  });

  // 没有「真跑一次工具调用」的用例：本仓的 mock provider 解析不出 baseURL
  // （`[AiSdkAdapter] 无法解析 provider "mock" 的 baseURL`），AgentLoop 起不到工具那一步。
  // runId 一致性因此由 evalOrchestrationArm.test.ts 的断言 + 反向变异守住，
  // 这里只钉「真构造不抛」这一段——它恰好是 mock 掉 ToolExecutor 时永远测不到的那段。
});
