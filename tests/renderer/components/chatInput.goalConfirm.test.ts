import { describe, expect, it } from 'vitest';
import {
  buildVerifyCandidates,
  shouldOpenGoalConfirm,
} from '../../../src/renderer/components/features/chat/ChatInput/goalConfirm';
import { parseGoalCommand } from '../../../src/renderer/components/features/chat/ChatInput/parseGoalCommand';

describe('shouldOpenGoalConfirm（/goal 主路径：自然语言→确认卡；显式 flags→直接启动）', () => {
  it('纯自然语言目标 → 走确认卡', () => {
    expect(shouldOpenGoalConfirm(parseGoalCommand('/goal 把首页改成深色'))).toBe(true);
  });

  it('显式 --verify → 不走确认卡（power-user 直接启动）', () => {
    expect(shouldOpenGoalConfirm(parseGoalCommand('/goal 修 bug --verify "npm test"'))).toBe(false);
  });

  it('显式 --review → 不走确认卡', () => {
    expect(shouldOpenGoalConfirm(parseGoalCommand("/goal 优化交互 --review '不出现绿色描边'"))).toBe(false);
  });

  it('显式预算类 flags（--max-turns / --budget / --max-time）→ 不走确认卡', () => {
    expect(shouldOpenGoalConfirm(parseGoalCommand('/goal 修 bug --max-turns 5'))).toBe(false);
    expect(shouldOpenGoalConfirm(parseGoalCommand('/goal 修 bug --budget 12000'))).toBe(false);
    expect(shouldOpenGoalConfirm(parseGoalCommand('/goal 修 bug --max-time 15'))).toBe(false);
  });

  it('空目标 / 解析失败 → 走确认卡（引导输入，不再是大表单）', () => {
    expect(shouldOpenGoalConfirm(parseGoalCommand('/goal'))).toBe(true);
    expect(shouldOpenGoalConfirm(null)).toBe(true);
  });
});

describe('buildVerifyCandidates（验证命令候选：只来自项目真实 scripts，fail-closed）', () => {
  const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts });

  it('从 package.json scripts 提取候选，验证类脚本优先', () => {
    const candidates = buildVerifyCandidates(pkg({
      dev: 'vite',
      build: 'vite build',
      test: 'vitest run',
      typecheck: 'tsc --noEmit',
      lint: 'eslint .',
    }));
    expect(candidates[0]).toBe('npm run typecheck');
    expect(candidates).toContain('npm test');
    expect(candidates).toContain('npm run lint');
    expect(candidates).toContain('npm run build');
  });

  it('排除常驻/交互类脚本（dev/start/serve/watch 会挂死验证闸）', () => {
    const candidates = buildVerifyCandidates(pkg({
      dev: 'vite',
      start: 'node server.js',
      serve: 'vite preview',
      'watch:css': 'tailwind --watch',
      test: 'vitest run',
    }));
    expect(candidates).toEqual(['npm test']);
  });

  it('test 脚本用 npm test，其余用 npm run <name>', () => {
    const candidates = buildVerifyCandidates(pkg({ test: 'vitest run', check: 'biome check' }));
    expect(candidates).toContain('npm test');
    expect(candidates).toContain('npm run check');
  });

  it('候选上限 6 个', () => {
    const scripts: Record<string, string> = {};
    for (let i = 0; i < 12; i++) scripts[`task${i}`] = 'echo ok';
    expect(buildVerifyCandidates(pkg(scripts)).length).toBeLessThanOrEqual(6);
  });

  it('无 package.json / 坏 JSON / 无 scripts → 空候选（绝不编造）', () => {
    expect(buildVerifyCandidates(null)).toEqual([]);
    expect(buildVerifyCandidates('{oops')).toEqual([]);
    expect(buildVerifyCandidates(JSON.stringify({ name: 'x' }))).toEqual([]);
  });
});
