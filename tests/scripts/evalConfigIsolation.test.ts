// ============================================================================
// N-PROV1：eval 与用户 config.json 的隔离策略是**有意的**，本测试钉死它的可诊断性
// ============================================================================
// eval 刻意不调 configService.initialize()（理由见 prepareRealEvalRuntime 的注释），
// 因此用户在 app 里自建的动态 custom provider 在这里不可见。这本身是策略；
// 真正的风险是**失败时说不清原因**——不拦的话要等到真正发请求才抛「无法解析 provider
// 的 baseURL」，看起来像 provider 配错了，而不是「eval 故意不读你的配置」。
// 2026-08-14 就有人（我）为此白查了一轮，并一度把根因写成「getSettings 白名单过滤」。
// ============================================================================

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const evalScript = path.join(repoRoot, 'packages', 'internal', 'evaluation-center', 'scripts', 'eval-ci.ts');

// 每次调用给独立数据目录，避免轮次间互相污染。
// ⚠️ 目录名不能含 'eval-config-isolation'——dotenvx 会把数据目录下的 .env 探测路径
// 打进 stdout，路径里带断言关键词会让「输出是否含该标签」变成自己检测自己的假阳性。
let dataDirSeq = 0;

function runEvalCi(env: Record<string, string>) {
  dataDirSeq += 1;
  const dataDir = path.join('/tmp', `code-agent-evalcfg-test-${dataDirSeq}`);
  return execFileAsync(
    process.execPath,
    [
      tsxCli,
      evalScript,
      '--real',
      '--provider',
      'custom-nonexistent-relay',
      '--model',
      'whatever',
      // 必须选 heldIn 桶里的 case：--split 默认 held-in，选到 heldOut 的 id
      // 会在到达 createAgent 之前就被过滤成空集而退出，测不到本守卫。
      '--ids',
      'bash-pwd',
      '--force',
      '--scope',
      'full',
      '--data-dir',
      dataDir,
    ],
    {
      cwd: repoRoot,
      timeout: 60_000,
      env: {
        ...process.env,
        AUTO_TEST_API_KEY: 'dummy-key-not-used',
        CODE_AGENT_DATA_DIR: '',
        ...env,
      },
    },
  );
}

describe('eval 配置隔离的 fail-loud', () => {
  it('动态 custom provider 缺 AUTO_TEST_BASE_URL 时，报出「这是隔离策略不是配置错误」', async () => {
    await expect(runEvalCi({})).rejects.toMatchObject({
      stderr: expect.stringContaining('eval-config-isolation'),
    });

    // 光有标签不够——错误必须自带出路，否则读的人还是只能猜
    await expect(runEvalCi({})).rejects.toMatchObject({
      stderr: expect.stringContaining('AUTO_TEST_BASE_URL'),
    });
  }, 130_000);

  it('给了 AUTO_TEST_BASE_URL 就放行（不再拦在这一关）', async () => {
    // 端点是假的，case 必然跑挂——但 eval 跑完 case 失败仍以 0 退出，
    // 所以这里不能假定 reject，只取输出判「有没有被隔离守卫拦下」。
    const output = await runEvalCi({ AUTO_TEST_BASE_URL: 'https://127.0.0.1:1/v1' })
      .then((r) => `${r.stdout}${r.stderr}`)
      .catch((e: { stdout?: string; stderr?: string }) => `${e.stdout ?? ''}${e.stderr ?? ''}`);

    expect(output).not.toContain('eval-config-isolation');
  }, 70_000);
});
