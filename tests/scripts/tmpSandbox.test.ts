import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createOwnedTmp, releaseOwnedTmp } from '../../scripts/lib/tmp-sandbox.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'lib', 'tmp-sandbox.mjs')).href;

const fixtureDirs: string[] = [];
const strayPaths: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  }
  for (const dir of fixtureDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const dir of strayPaths.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeFixture(name: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-tmp-sandbox-fixture-'));
  fixtureDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

/** 建了登记目录 + 一个未登记兄弟目录的最小进程——门被 SIGTERM 时的真实形状。 */
function signalChildSource(): string {
  return `
import { createOwnedTmp } from ${JSON.stringify(moduleUrl)};
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const owned = createOwnedTmp('gates-fast-');
fs.writeFileSync(path.join(owned, 'marker'), 'x');
// 未登记的兄弟目录：退出清理必须只删自己登记的路径，不能顺手扫同前缀的别人。
const bystander = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-tmp-sandbox-bystander-'));
console.log('CHILD_READY ' + JSON.stringify({ owned, bystander }));
setInterval(() => {}, 1 << 30);
`;
}

interface StartedChild {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  /** 等子进程 stdout 里出现以 marker 开头的行，返回去掉 marker 的剩余部分。 */
  readLine(marker: string, timeoutMs?: number): Promise<string>;
  waitClosed(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function startChild(file: string, args: string[] = [], env: NodeJS.ProcessEnv = {}): StartedChild {
  const child = spawn(process.execPath, [file, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  async function waitFor(probe: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!probe()) {
      if (Date.now() > deadline) throw new Error(`等不到 ${what}（${timeoutMs}ms）；stdout=${stdout}; stderr=${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return {
    child,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    async readLine(marker, timeoutMs = 15_000) {
      await waitFor(() => stdout.split('\n').some((line) => line.startsWith(marker)), timeoutMs, `${marker} 行`);
      return stdout.split('\n').find((line) => line.startsWith(marker))!.slice(marker.length);
    },
    async waitClosed(timeoutMs = 15_000) {
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, timeoutMs, '子进程退出');
      return { code: child.exitCode, signal: child.signalCode };
    },
  };
}

describe('tmp-sandbox 退出自清（N-GATES-TMP-SELFCLEAN）', () => {
  it('SIGTERM：登记目录被清、退出码 130、未登记的兄弟目录原样保留', async () => {
    const file = writeFixture('signal-child.mjs', signalChildSource());
    const started = startChild(file);
    const { owned, bystander } = JSON.parse(await started.readLine('CHILD_READY ')) as { owned: string; bystander: string };
    strayPaths.push(bystander); // 兜底清理，防测试红时泄漏
    expect(fs.existsSync(owned)).toBe(true);

    started.child.kill('SIGTERM');
    const closed = await started.waitClosed();
    expect(closed.code).toBe(130);
    expect(fs.existsSync(owned)).toBe(false);
    // 只删自己登记的路径：同在 tmp 里的未登记目录不许被顺带删掉（08-18 教训）。
    expect(fs.existsSync(bystander)).toBe(true);
  }, 30_000);

  it('宿主先注册的信号钩子（gates-local 的 releaseLock 形状）先跑，exit 钩子兜底清目录', async () => {
    const file = writeFixture('coexist-child.mjs', `
import { createOwnedTmp } from ${JSON.stringify(moduleUrl)};
import fs from 'node:fs';
process.on('SIGTERM', () => {
  console.log('RELEASE_LOCK_RAN');
  process.exit(130);
});
const owned = createOwnedTmp('code-agent-gates-renderer-base-');
fs.writeFileSync(owned + '/marker', 'x');
console.log('CHILD_READY ' + owned);
setInterval(() => {}, 1 << 30);
`);
    const started = startChild(file);
    const owned = await started.readLine('CHILD_READY ');
    strayPaths.push(owned);

    started.child.kill('SIGTERM');
    const closed = await started.waitClosed();
    // 宿主自己的钩子确实先跑（releaseLock 语义保留），退出码仍是 130。
    expect(closed.code).toBe(130);
    expect(started.stdout).toContain('RELEASE_LOCK_RAN');
    // 目录由 tmp-sandbox 的 exit 钩子在 process.exit 内清掉。
    expect(fs.existsSync(owned)).toBe(false);
  }, 30_000);

  it('--keep-tmp：SIGTERM 后目录保留，且 stderr 打印了路径', async () => {
    const file = writeFixture('keep-child.mjs', signalChildSource());
    const started = startChild(file, ['--keep-tmp']);
    const { owned } = JSON.parse(await started.readLine('CHILD_READY ')) as { owned: string };
    strayPaths.push(owned);

    started.child.kill('SIGTERM');
    await started.waitClosed();
    expect(fs.existsSync(owned)).toBe(true);
    expect(started.stderr).toContain(owned);
    expect(started.stderr).toContain('keep-tmp');
  }, 30_000);

  it('CODE_AGENT_KEEP_TMP=1 与 --keep-tmp 等效', async () => {
    const file = writeFixture('keep-env-child.mjs', signalChildSource());
    const started = startChild(file, [], { CODE_AGENT_KEEP_TMP: '1' });
    const { owned } = JSON.parse(await started.readLine('CHILD_READY ')) as { owned: string };
    strayPaths.push(owned);

    started.child.kill('SIGTERM');
    await started.waitClosed();
    expect(fs.existsSync(owned)).toBe(true);
    expect(started.stderr).toContain(owned);
  }, 30_000);

  it('正常路径：createOwnedTmp 建目录，releaseOwnedTmp 删目录（无需信号）', () => {
    const dir = createOwnedTmp('gates-fast-');
    expect(fs.existsSync(dir)).toBe(true);
    releaseOwnedTmp(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('门脚本临时根接线（static contract）', () => {
  it('gates-fast 的临时根走 createOwnedTmp，不再有裸 mkdtempSync', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'scripts', 'gates-fast.mjs'), 'utf-8');
    expect(source).toContain("createOwnedTmp('gates-fast-')");
    expect(source).not.toContain("mkdtempSync(path.join(os.tmpdir(), 'gates-fast-')");
  });

  it('gates-local 的 renderer-base 临时根走 createOwnedTmp', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'scripts', 'gates-local.mjs'), 'utf-8');
    expect(source).toContain("createOwnedTmp('code-agent-gates-renderer-base-')");
    expect(source).not.toContain("mkdtempSync(path.join(os.tmpdir(), 'code-agent-gates-renderer-base-')");
  });
});
