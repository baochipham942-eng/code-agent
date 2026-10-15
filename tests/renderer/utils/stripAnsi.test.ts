// ============================================================================
// stripAnsi（N-IACT-RUN-HANDOFF-NEO-FU1）：PTY 输出进 `!run` 卡两条出口前的剥壳
// 契约——CSI 颜色码、OSC 标题、其余 ESC 序列全剥；单字节 0x9b 开头的 CSI 也认；
// 纯文本走快速路径原样返回（值与 === 都不动）；中文与 emoji 不受伤；纯转义
// 序列剥完为空。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../../../src/renderer/utils/stripAnsi';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

describe('stripAnsi', () => {
  it('剥掉 CSI 颜色码（真实 ls 输出形状：ESC[34m / ESC[39;49m / ESC[0m），正文留下', () => {
    const coloured = `${ESC}[34m${ESC}[1mads${ESC}[0m ${ESC}[39;49mbin${ESC}[39;49m${ESC}[0m`;
    expect(stripAnsi(coloured)).toBe('ads bin');
  });

  it('剥掉 OSC 标题序列：BEL 与 ESC \\ 两种收尾都认', () => {
    expect(stripAnsi(`${ESC}]0;user@host: ~/work${BEL}ls work`)).toBe('ls work');
    expect(stripAnsi(`${ESC}]2;标题${ESC}\\echo ok`)).toBe('echo ok');
  });

  it('剥掉其余 ESC 序列（ESC 7 存光标、ESC ( B 选字符集）与单字节 0x9b 开头的 CSI', () => {
    expect(stripAnsi(`${ESC}7${ESC}(B恢复点`)).toBe('恢复点');
    expect(stripAnsi(`${String.fromCharCode(0x9b)}34m蓝色${String.fromCharCode(0x9b)}0m`)).toBe('蓝色');
  });

  it('纯文本走快速路径原样返回：内容相等且 === 同一串', () => {
    const plain = 'total 0\r\ndrwxr-xr-x  src\n- 纯文本，一个控制字符都没有';
    expect(stripAnsi(plain)).toBe(plain);
    expect(stripAnsi(plain) === plain).toBe(true);
  });

  it('中文与 emoji 完整保留', () => {
    expect(stripAnsi(`${ESC}[32m通过 ✓ 🎉${ESC}[0m`)).toBe('通过 ✓ 🎉');
  });

  it('纯转义序列剥完为空', () => {
    expect(stripAnsi(`${ESC}[34m${ESC}[39;49m${ESC}[0m`)).toBe('');
  });
});
