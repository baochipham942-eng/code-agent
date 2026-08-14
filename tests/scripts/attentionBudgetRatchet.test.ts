import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/attention-budget-ratchet.mjs');
const roots: string[] = [];

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'attention-budget-ratchet-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'docs/architecture'), { recursive: true });
  mkdirSync(join(root, 'src/host/agent/runtime'), { recursive: true });
  mkdirSync(join(root, 'src/host/agent'), { recursive: true });
  writeFileSync(join(root, 'scripts/attention-budget-ratchet-baseline.json'), JSON.stringify({
    schemaVersion: 1,
    globalFixedTokens: 0,
    liveVoiceFixedTokens: 55,
    liveVoiceToleranceRatio: 0.1,
    panoramaMatchedFiles: 1,
    astCallCount: 1,
    panoramaPointCount: 1,
    reason: '测试基线',
  }));
  writeFileSync(join(root, 'docs/architecture/injection-panorama.md'), [
    "`rg -l 'injectSystemMessage|system_reminder' src/host` 当前命中 1 个文件",
    '| 注入点 | 内容 | 触发条件 | 频次 | token |',
    '| --- | --- | --- | --- | ---: |',
    '| `src/host/agent/runtime/example.ts:2 <conditional>` | 条件提示 | flag | 条件触发 | ~2 |',
  ].join('\n'));
  writeFileSync(join(root, 'src/host/agent/runtime/example.ts'), [
    'export function inject(flag: boolean, injectSystemMessage: (text: string) => void) {',
    "  if (flag) injectSystemMessage('条件提示');",
    '}',
  ].join('\n'));
  writeFileSync(join(root, 'src/host/agent/orchestratorTurnContext.ts'), [
    'export function notice() {',
    '  return [',
    "    '<live_voice_permission_notice>',",
    "    `当前处于实时语音通话中，本轮权限档为 ${'${mode}'}（通话跟随会话自己的权限设置，不额外收紧）。`,",
    "    '需要用户确认的操作会挂起等待审批卡；用户正在通话、不在键盘前，可能不会立刻确认。',",
    "    '不要因为一次尝试没有立即成功就反复更换写法重试，等待审批结果即可。',",
    "    '</live_voice_permission_notice>',",
    "  ].join('\\n');",
    '}',
  ].join('\n'));
  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, [script, '--repo-root', root], { encoding: 'utf8' });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('attention-budget-ratchet', () => {
  it('基线现场为绿', () => {
    const result = run(makeFixture());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('本地无守卫静态注入总量 current=0 baseline=0');
    expect(result.stdout).toContain('✓ 注入点计数、无守卫静态总量与语音固定开销均未超基线');
  });

  it('人为增加无条件每轮注入后报红并点名调用点与过审路径', () => {
    const root = makeFixture();
    const file = join(root, 'src/host/agent/runtime/example.ts');
    appendFileSync(file, "\nexport function added(injectSystemMessage: (text: string) => void) { injectSystemMessage('新增无条件每轮固定文案'); }\n");
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('调用数 current=2 baseline=1');
    expect(result.stderr).toContain('无条件静态注入调用点');
    expect(result.stderr).toContain('本地无守卫静态注入总量超基线');
    expect(result.stderr).toContain('改成条件触发或降频');
    expect(result.stderr).toContain('基线文件显式提额并写理由');
  });

  it('扫描路径失效或全景表文件数漂移时 fail-loud', () => {
    const root = makeFixture();
    writeFileSync(join(root, 'src/host/agent/runtime/example.ts'), 'export const value = 1;\n');
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('扫描命中 0 个文件');
  });
});
