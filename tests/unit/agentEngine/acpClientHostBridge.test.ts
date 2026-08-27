import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AcpClientHostBridge } from '../../../src/host/services/agentEngine/acpClientHostBridge';
import type { PermissionAskResult, PermissionRequest } from '../../../src/shared/contract/permission';

/**
 * 这一层是 ACP 路线上唯一的安全边界。
 *
 * 前提事实（2026-08-27 Kimi 0.38.0 真机抓包）：ACP agent 自己不执行任何副作用——
 * 写文件走 fs/write_text_file、跑命令走 terminal/create，全部反向委托回 Neo。
 * 所以「批没批」不在对方手里，就在本文件测的这几个方法里。
 */
let workspace: string;

async function makeWorkspace(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'acp-bridge-'));
}

function bridgeWith(ask?: (request: Omit<PermissionRequest, 'id' | 'timestamp'>) => Promise<PermissionAskResult>) {
  return new AcpClientHostBridge({
    workspaceRoot: workspace,
    cwd: workspace,
    sessionId: 'session-under-test',
    ...(ask ? { requestPermission: ask } : {}),
  });
}

const approve = vi.fn<(request: Omit<PermissionRequest, 'id' | 'timestamp'>) => Promise<PermissionAskResult>>();

beforeEach(async () => {
  workspace = await makeWorkspace();
  approve.mockReset();
});
afterEach(async () => {
  await fsp.rm(workspace, { recursive: true, force: true });
});

describe('AcpClientHostBridge — 写文件闸', () => {
  it('没有审批口时 fail-closed 拒绝，并且不落盘', async () => {
    const bridge = bridgeWith(undefined);
    const target = path.join(workspace, 'a.txt');
    await expect(bridge.writeTextFile({ path: target, content: 'hi' })).rejects.toThrow(/denied/i);
    await expect(fsp.readFile(target, 'utf8')).rejects.toThrow();
  });

  it('审批链自己抛错也算拒绝，不能当成放行', async () => {
    const bridge = bridgeWith(async () => { throw new Error('approval chain exploded'); });
    const target = path.join(workspace, 'b.txt');
    await expect(bridge.writeTextFile({ path: target, content: 'hi' })).rejects.toThrow(/denied/i);
    await expect(fsp.readFile(target, 'utf8')).rejects.toThrow();
  });

  it('用户拒绝时不落盘', async () => {
    approve.mockResolvedValue({ approved: false, denialSource: 'user' });
    const bridge = bridgeWith(approve);
    const target = path.join(workspace, 'c.txt');
    await expect(bridge.writeTextFile({ path: target, content: 'hi' })).rejects.toThrow(/denied/i);
    await expect(fsp.readFile(target, 'utf8')).rejects.toThrow();
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('用户批准后真落盘，且审批卡带上 diff 预览与文件路径', async () => {
    approve.mockResolvedValue({ approved: true });
    const bridge = bridgeWith(approve);
    const target = path.join(workspace, 'nested', 'd.txt');
    await bridge.writeTextFile({ path: target, content: 'hi' });
    expect(await fsp.readFile(target, 'utf8')).toBe('hi');

    const request = approve.mock.calls[0]![0];
    expect(request.type).toBe('file_write');
    expect(request.tool).toBe('acp:fs/write_text_file');
    expect(request.details.filePath).toBe(target);
    expect(request.details.preview).toMatchObject({ type: 'diff', after: 'hi' });
  });

  it('写工作区外的文件标成 danger，并给出跨边界的结构化原因码', async () => {
    approve.mockResolvedValue({ approved: true });
    const bridge = bridgeWith(approve);
    const outside = path.join(await makeWorkspace(), 'outside.txt');
    await bridge.writeTextFile({ path: outside, content: 'x' });
    const request = approve.mock.calls[0]![0];
    expect(request.dangerLevel).toBe('danger');
    expect(request.reasonCode).toBe('file_write_outside_workspace');
    await fsp.rm(path.dirname(outside), { recursive: true, force: true });
  });
});

describe('AcpClientHostBridge — 读文件闸', () => {
  it('工作区内的读不打扰用户', async () => {
    const target = path.join(workspace, 'inside.txt');
    await fsp.writeFile(target, 'inside', 'utf8');
    const bridge = bridgeWith(approve);
    expect(await bridge.readTextFile({ path: target })).toEqual({ content: 'inside' });
    expect(approve).not.toHaveBeenCalled();
  });

  it('读工作区外的文件要过审批，没有审批口就拒', async () => {
    const other = await makeWorkspace();
    const secret = path.join(other, 'secret.txt');
    await fsp.writeFile(secret, 'classified', 'utf8');
    const bridge = bridgeWith(undefined);
    await expect(bridge.readTextFile({ path: secret })).rejects.toThrow(/denied/i);
    await fsp.rm(other, { recursive: true, force: true });
  });

  /**
   * 判越界必须用 path.relative，不能用字符串前缀：`<ws>-evil` 会前缀命中 `<ws>`，
   * 于是一个位于工作区**外**的目录被当成工作区内直接放行。
   */
  it('同前缀的兄弟目录算工作区外，不许被前缀匹配蒙混过关', async () => {
    const sibling = `${workspace}-evil`;
    await fsp.mkdir(sibling, { recursive: true });
    await fsp.writeFile(path.join(sibling, 's.txt'), 'nope', 'utf8');
    const bridge = bridgeWith(undefined);
    await expect(bridge.readTextFile({ path: path.join(sibling, 's.txt') })).rejects.toThrow(/denied/i);
    await fsp.rm(sibling, { recursive: true, force: true });
  });
});

describe('AcpClientHostBridge — 跑命令闸', () => {
  it('没有审批口时拒绝创建终端', async () => {
    const bridge = bridgeWith(undefined);
    await expect(bridge.createTerminal({ command: '/bin/echo', args: ['hi'] })).rejects.toThrow(/denied/i);
  });

  it('审批卡里带的是完整命令行，不是只有可执行文件名', async () => {
    approve.mockResolvedValue({ approved: false });
    const bridge = bridgeWith(approve);
    await expect(
      bridge.createTerminal({ command: '/bin/bash', args: ['-c', 'rm -rf /'] }),
    ).rejects.toThrow(/denied/i);
    const request = approve.mock.calls[0]![0];
    expect(request.type).toBe('command');
    expect(request.details.command).toBe('/bin/bash -c rm -rf /');
    expect(request.reasonCode).toBe('shell_high_risk');
  });

  it('批准后命令真的跑起来并能取到输出与退出码', async () => {
    approve.mockResolvedValue({ approved: true });
    const bridge = bridgeWith(approve);
    const { terminalId } = await bridge.createTerminal({ command: '/bin/echo', args: ['hello-acp'] });
    const exit = await bridge.waitForTerminalExit(terminalId);
    expect(exit.exitCode).toBe(0);
    expect(bridge.terminalOutput(terminalId).output).toContain('hello-acp');
    bridge.releaseTerminal(terminalId);
    expect(() => bridge.terminalOutput(terminalId)).toThrow(/Unknown ACP terminal/);
  });

  it('cwd 不许逃出工作区，即使审批已放行', async () => {
    approve.mockResolvedValue({ approved: true });
    const other = await makeWorkspace();
    const bridge = bridgeWith(approve);
    await expect(
      bridge.createTerminal({ command: '/bin/echo', args: ['x'], cwd: other }),
    ).rejects.toThrow(/inside the session workspace/);
    await fsp.rm(other, { recursive: true, force: true });
  });
});

describe('AcpClientHostBridge — session/request_permission 翻译', () => {
  const options = [
    { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  ];

  it('批准时挑 agent 给的 allow 选项', async () => {
    approve.mockResolvedValue({ approved: true });
    const bridge = bridgeWith(approve);
    await expect(bridge.requestToolPermission({ toolCall: { title: 'Bash', kind: 'execute' }, options }))
      .resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
  });

  it('拒绝时挑 agent 给的 reject 选项', async () => {
    approve.mockResolvedValue({ approved: false });
    const bridge = bridgeWith(approve);
    await expect(bridge.requestToolPermission({ toolCall: { title: 'Bash', kind: 'execute' }, options }))
      .resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
  });

  it('没有审批口时 fail-closed：不选 allow', async () => {
    const bridge = bridgeWith(undefined);
    const result = await bridge.requestToolPermission({ toolCall: { title: 'Bash', kind: 'execute' }, options });
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
  });

  it('agent 一个选项都没给时回 cancelled，绝不臆造一个 optionId', async () => {
    approve.mockResolvedValue({ approved: true });
    const bridge = bridgeWith(approve);
    await expect(bridge.requestToolPermission({ toolCall: { title: 'X' }, options: [] }))
      .resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });
});
