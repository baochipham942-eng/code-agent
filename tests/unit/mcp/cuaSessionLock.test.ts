import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  tryAcquireCuaLock,
  releaseCuaLock,
  gateCuaToolCall,
  CUA_LOCK_TTL_MS,
} from '../../../src/main/mcp/cuaSessionLock';

describe('cuaSessionLock — 跨会话 computer-use 文件锁', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cua-lock-'));
    lockPath = join(dir, 'computer-use.lock');
    process.env.CODE_AGENT_CU_LOCK_PATH = lockPath;
  });

  afterEach(() => {
    delete process.env.CODE_AGENT_CU_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  it('空闲时获取成功，并写入兼容 argus 格式的锁文件', async () => {
    const result = await tryAcquireCuaLock('session-a');
    expect(result.kind).toBe('acquired');

    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    // argus/Claude Code 的 isComputerUseLock 只校验这两个字段，保持兼容
    expect(lock.sessionId).toBe('session-a');
    expect(lock.pid).toBe(process.pid);
  });

  it('同一 session 重入获取成功', async () => {
    await tryAcquireCuaLock('session-a');
    const result = await tryAcquireCuaLock('session-a');
    expect(result.kind).toBe('acquired');
  });

  it('被存活的外部进程持有时返回 blocked，且不破坏对方锁文件', async () => {
    // 模拟另一个存活进程（用 pid 1，launchd 永远存活且不属于我们）
    writeFileSync(
      lockPath,
      JSON.stringify({ sessionId: 'other-session', pid: 1, acquiredAt: Date.now() }),
    );
    const result = await tryAcquireCuaLock('session-a');
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.by).toBe('other-session');
    }
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(lock.sessionId).toBe('other-session');
  });

  it('持有者进程已死时回收锁并获取成功', async () => {
    // 一个几乎不可能存在的 pid
    writeFileSync(
      lockPath,
      JSON.stringify({ sessionId: 'dead-session', pid: 999999, acquiredAt: Date.now() }),
    );
    const result = await tryAcquireCuaLock('session-a');
    expect(result.kind).toBe('acquired');
  });

  it('同进程内另一会话持有且未超时 → blocked（不允许两个会话交错操作桌面）', async () => {
    await tryAcquireCuaLock('session-a');
    const result = await tryAcquireCuaLock('session-b');
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.by).toBe('session-a');
    }
  });

  it('同进程内另一会话持有但已闲置超过 TTL → 可接管', async () => {
    const stale = Date.now() - CUA_LOCK_TTL_MS - 1000;
    writeFileSync(
      lockPath,
      JSON.stringify({
        sessionId: 'idle-session',
        pid: process.pid,
        acquiredAt: stale,
        lastUsedAt: stale,
      }),
    );
    const result = await tryAcquireCuaLock('session-b');
    expect(result.kind).toBe('acquired');
  });

  it('外部存活进程的锁即使超过 TTL 也不接管（不抢活进程的桌面）', async () => {
    const stale = Date.now() - CUA_LOCK_TTL_MS - 1000;
    writeFileSync(
      lockPath,
      JSON.stringify({ sessionId: 'other', pid: 1, acquiredAt: stale, lastUsedAt: stale }),
    );
    const result = await tryAcquireCuaLock('session-a');
    expect(result.kind).toBe('blocked');
  });

  it('损坏的锁文件按陈旧处理：清掉并获取成功', async () => {
    writeFileSync(lockPath, 'not-json{{{');
    const result = await tryAcquireCuaLock('session-a');
    expect(result.kind).toBe('acquired');
  });

  it('release 只删除自己持有的锁', async () => {
    await tryAcquireCuaLock('session-a');
    expect(await releaseCuaLock('session-b')).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(await releaseCuaLock('session-a')).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('gate：只读工具（screenshot/get_window_state 等）不需要锁，被占用时也放行', async () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ sessionId: 'other-session', pid: 1, acquiredAt: Date.now() }),
    );
    expect(await gateCuaToolCall('screenshot', 'session-a')).toBeNull();
    expect(await gateCuaToolCall('get_window_state', 'session-a')).toBeNull();
    expect(await gateCuaToolCall('list_apps', 'session-a')).toBeNull();
    expect(await gateCuaToolCall('check_permissions', 'session-a')).toBeNull();
  });

  it('gate：会话声明与观察类工具放行（实测 cua-driver 0.5.1 的 35 工具清单）', async () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ sessionId: 'other-session', pid: 1, acquiredAt: Date.now() }),
    );
    // end_session 必须放行：占锁会话之外的 run 也要能善后自己的 agent cursor
    expect(await gateCuaToolCall('end_session', 'session-a')).toBeNull();
    // start_session 只声明 run 身份不碰桌面，纯观察 run 也需要它
    expect(await gateCuaToolCall('start_session', 'session-a')).toBeNull();
    for (const tool of [
      'get_screen_size',
      'get_cursor_position',
      'get_config',
      'get_agent_cursor_state',
      'get_recording_state',
      'check_for_update',
    ]) {
      expect(await gateCuaToolCall(tool, 'session-a'), tool).toBeNull();
    }
  });

  it('gate：操控类工具空闲时放行并占锁', async () => {
    expect(await gateCuaToolCall('click', 'session-a')).toBeNull();
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(lock.sessionId).toBe('session-a');
  });

  it('gate：操控类工具被其他会话占用时返回可执行的错误信息', async () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ sessionId: 'other-session', pid: 1, acquiredAt: Date.now() }),
    );
    const err = await gateCuaToolCall('type_text', 'session-a');
    expect(err).not.toBeNull();
    expect(err).toContain('other-session');
  });

  it('gate：未知工具名按操控类处理（默认拒绝优于默认放行）', async () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ sessionId: 'other-session', pid: 1, acquiredAt: Date.now() }),
    );
    expect(await gateCuaToolCall('future_new_tool', 'session-a')).not.toBeNull();
  });

  it('重入获取会刷新 lastUsedAt（活跃轨迹不会被 TTL 接管）', async () => {
    await tryAcquireCuaLock('session-a');
    const before = JSON.parse(readFileSync(lockPath, 'utf8')).lastUsedAt;
    await new Promise((r) => setTimeout(r, 10));
    await tryAcquireCuaLock('session-a');
    const after = JSON.parse(readFileSync(lockPath, 'utf8')).lastUsedAt;
    expect(after).toBeGreaterThan(before);
  });
});
