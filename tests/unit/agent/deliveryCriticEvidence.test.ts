// ============================================================================
// #7 证据驱动配套单测：验证命令识别 + NudgeManager 验证证据 run 生命周期
// ============================================================================

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { isVerificationCommand } from '../../../src/host/agent/runtime/toolResultLifecycle';
import { NudgeManager } from '../../../src/host/agent/nudgeManager';

describe('isVerificationCommand (#7)', () => {
  it('识别 npm/pnpm/yarn 的 test/typecheck/lint/build', () => {
    expect(isVerificationCommand('npm run typecheck')).toBe(true);
    expect(isVerificationCommand('npm test')).toBe(true);
    expect(isVerificationCommand('pnpm run lint')).toBe(true);
    expect(isVerificationCommand('yarn build')).toBe(true);
  });

  it('识别裸命令 tsc/vitest/jest/pytest/eslint', () => {
    expect(isVerificationCommand('npx vitest run foo.test.ts')).toBe(true);
    expect(isVerificationCommand('tsc --noEmit')).toBe(true);
    expect(isVerificationCommand('pytest tests/')).toBe(true);
    expect(isVerificationCommand('eslint src/')).toBe(true);
  });

  it('识别 cargo/go 验证命令', () => {
    expect(isVerificationCommand('cargo test')).toBe(true);
    expect(isVerificationCommand('go test ./...')).toBe(true);
  });

  it('非验证命令不误判', () => {
    expect(isVerificationCommand('ls -la')).toBe(false);
    expect(isVerificationCommand('git status')).toBe(false);
    expect(isVerificationCommand('cat package.json')).toBe(false);
    expect(isVerificationCommand('echo "testing the waters"')).toBe(false);
    expect(isVerificationCommand('echo test')).toBe(false);
    expect(isVerificationCommand('cat x.test.ts')).toBe(false);
    expect(isVerificationCommand('git test-branch')).toBe(false);
    expect(isVerificationCommand('npm install @testing-library/react')).toBe(false);
    expect(isVerificationCommand('npm install')).toBe(false);
  });

  // Codex Round 1 真缺口（false-negatives）：workspace 选择器 / make / npm run ci
  it('识别 workspace/filter 选择器后的验证脚本（Codex R1）', () => {
    expect(isVerificationCommand('pnpm -F pkg test')).toBe(true);
    expect(isVerificationCommand('pnpm --filter pkg test')).toBe(true);
    expect(isVerificationCommand('npm --workspace foo test')).toBe(true);
    expect(isVerificationCommand('npm -w foo run typecheck')).toBe(true);
  });

  it('识别 make 验证子命令（Codex R1）', () => {
    expect(isVerificationCommand('make test')).toBe(true);
    expect(isVerificationCommand('make lint')).toBe(true);
    expect(isVerificationCommand('make build')).toBe(true);
    expect(isVerificationCommand('make deploy')).toBe(false);
  });

  it('npm run ci = 验证，但 npm ci = 安装（不误判，Codex R1 衍生）', () => {
    expect(isVerificationCommand('npm run ci')).toBe(true);
    expect(isVerificationCommand('npm ci')).toBe(false);
  });

  it('npx/dlx 运行 verifier 二进制', () => {
    expect(isVerificationCommand('npx tsc -p .')).toBe(true);
    expect(isVerificationCommand('pnpm dlx tsc')).toBe(true);
    expect(isVerificationCommand('npx eslint src/')).toBe(true);
    expect(isVerificationCommand('npx prettier --write .')).toBe(false);
  });

  it('复合命令任一段命中即算验证；前导 env 赋值不干扰', () => {
    expect(isVerificationCommand('npm run build && npm test')).toBe(true);
    expect(isVerificationCommand('CI=1 npm test')).toBe(true);
    expect(isVerificationCommand('cd foo && ls')).toBe(false);
  });

  it('绝对/相对路径的 verifier 二进制按 basename 识别', () => {
    expect(isVerificationCommand('./node_modules/.bin/vitest run')).toBe(true);
    expect(isVerificationCommand('/usr/bin/python3 -m pytest')).toBe(true);
  });
});

describe('NudgeManager 验证证据 (#7)', () => {
  function fresh(): NudgeManager {
    const m = new NudgeManager();
    m.reset([], 'task', '/tmp', []);
    return m;
  }

  it('默认 none', () => {
    expect(fresh().getVerificationOutcome()).toBe('none');
  });

  it('recordVerification(true/false) latest-wins', () => {
    const m = fresh();
    m.recordVerification(false);
    expect(m.getVerificationOutcome()).toBe('failed');
    m.recordVerification(true); // 修复后再验证通过
    expect(m.getVerificationOutcome()).toBe('passed');
  });

  it('reset 清回 none（run 生命周期）', () => {
    const m = fresh();
    m.recordVerification(true);
    m.reset([], 'task2', '/tmp', []);
    expect(m.getVerificationOutcome()).toBe('none');
  });
});
