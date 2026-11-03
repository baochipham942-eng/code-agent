// 「保持聊天同步」偏好文件（N-EXTHISTORY-IMPORT-SYNC-CHATS 验收①）
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../src/host/services/infra/logger', () => ({ createLogger: () => logger }));

import { readChatsSyncState, writeChatsSyncState } from '../../../src/host/externalImport/chatsSyncPreference';

let dir: string;
const file = () => path.join(dir, 'external-chats-sync.json');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-sync-pref-'));
  vi.stubEnv('CODE_AGENT_DATA_DIR', dir);
  logger.warn.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('chatsSyncPreference', () => {
  it('缺文件 = off，且不 warn', () => {
    expect(readChatsSyncState()).toEqual({ mode: 'off' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('round-trip：mode + lastRun 原样读回，文件带 version:1', () => {
    writeChatsSyncState({ mode: 'paused', lastRun: { at: 123, imported: 4 } });
    expect(readChatsSyncState()).toEqual({ mode: 'paused', lastRun: { at: 123, imported: 4 } });
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8')).version).toBe(1);
  });

  it('损坏 JSON => off + warn 写明原因', () => {
    fs.writeFileSync(file(), '{not json');
    expect(readChatsSyncState()).toEqual({ mode: 'off' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('corrupt'), expect.objectContaining({ error: expect.any(String) }));
  });

  it('mode 非法 => off + warn', () => {
    fs.writeFileSync(file(), JSON.stringify({ version: 1, mode: 'always' }));
    expect(readChatsSyncState()).toEqual({ mode: 'off' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no valid mode'), expect.anything());
  });

  it('不可读（路径是目录）=> off + warn', () => {
    fs.mkdirSync(file());
    expect(readChatsSyncState()).toEqual({ mode: 'off' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to read'), expect.anything());
  });
});
