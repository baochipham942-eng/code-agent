import { describe, expect, it, vi } from 'vitest';

// 密钥落盘失败的注入点：writeFileSync 抛 ENOSPC（磁盘满）。readFileSync / renameSync 保持真实现，
// 「首次启动没有密钥文件」路径仍走真实 ENOENT——只让写盘这一步失败，别把失败形状 mock 假了。
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: () => {
      const error = new Error('ENOSPC: no space left on device, write ticket-key.tmp') as NodeJS.ErrnoException;
      error.code = 'ENOSPC';
      throw error;
    },
  };
});

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayTicketAuth } from '../../../packages/relay/src/ticketAuth';

const NOW = 1_800_000_000_000;

describe('RelayTicketAuth key file', () => {
  it('falls back to an in-process key with a ticket_key_ephemeral warn when the write fails (ENOSPC)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-ticket-key-'));
    try {
      const keyFile = join(dir, 'ticket-key');
      const warns: string[] = [];
      // index.ts 在 uncaughtException 注册之前、listen 之前就同步 new RelayTicketAuth：
      // 构造抛栈＝systemd 重启循环，连不用票据的共享凭据通道一起断。这里不得抛。
      const auth = new RelayTicketAuth({
        keyFile,
        now: () => NOW,
        logger: { warn: (event, fields) => warns.push(JSON.stringify({ event, ...fields })) },
      });
      // 拿到的是可用的进程内密钥：当场签的票当场验得过
      const { ticket } = auth.issue('user-1');
      expect(auth.verify(ticket)).toMatchObject({ sub: 'user-1' });
      expect(auth.keyBytes).toHaveLength(32);
      // 密钥确实没落盘（write 全灭）：重启后的另一个实例拿另一把进程内随机密钥，验不了这张票
      const restarted = new RelayTicketAuth({ keyFile, now: () => NOW, logger: { warn: () => {} } });
      expect(restarted.verify(ticket)).toBeNull();
      expect(existsSync(keyFile)).toBe(false);
      // warn：事件名 +「重启后失效」后果 + 这次失败的可区分原因（ENOSPC）
      const text = warns.join('\n');
      expect(text).toContain('"event":"ticket_key_ephemeral"');
      expect(text).toContain('invalid once this process restarts');
      expect(text).toContain('ENOSPC');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
