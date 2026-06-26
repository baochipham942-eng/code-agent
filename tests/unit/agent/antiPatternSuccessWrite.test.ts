// ============================================================================
// #5 成功写 storm breaker — trackSuccessfulWrite
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/main/mcp/logCollector', () => ({
  logCollector: { agent: vi.fn() },
}));

import { AntiPatternDetector } from '../../../src/main/agent/antiPattern/detector';
import type { ToolCall } from '../../../src/shared/contract';

function write(filePath: string, content: string, name = 'write_file'): ToolCall {
  return { id: `c-${Math.random()}`, name, arguments: { file_path: filePath, content } } as ToolCall;
}
function edit(filePath: string, newString: string): ToolCall {
  return { id: `c-${Math.random()}`, name: 'edit_file', arguments: { file_path: filePath, old_string: 'x', new_string: newString } } as ToolCall;
}

describe('AntiPatternDetector.trackSuccessfulWrite (#5)', () => {
  let detector: AntiPatternDetector;
  beforeEach(() => { detector = new AntiPatternDetector(); });

  it('同一文件写入相同内容第 2 次触发 storm 警告', () => {
    expect(detector.trackSuccessfulWrite(write('/a.ts', 'function foo(){}'))).toBeNull();
    const warning = detector.trackSuccessfulWrite(write('/a.ts', 'function foo(){}'));
    expect(warning).not.toBeNull();
    expect(warning).toContain('success-write-storm');
    expect(warning).toContain('/a.ts');
  });

  it('内容仅 whitespace/大小写"略变"归一为同签名，仍触发', () => {
    expect(detector.trackSuccessfulWrite(write('/a.ts', 'function Foo() {}'))).toBeNull();
    // 缩进/大小写变化 → 归一后同签名
    const warning = detector.trackSuccessfulWrite(write('/a.ts', '  function foo(){}  '));
    expect(warning).not.toBeNull();
    expect(warning).toContain('success-write-storm');
  });

  it('内容真实变更（不同逻辑）→ 不同签名，不误伤正常迭代', () => {
    expect(detector.trackSuccessfulWrite(write('/a.ts', 'function foo(){ return 1; }'))).toBeNull();
    expect(detector.trackSuccessfulWrite(write('/a.ts', 'function foo(){ return 2; }'))).toBeNull();
    expect(detector.trackSuccessfulWrite(write('/a.ts', 'function foo(){ return 3; }'))).toBeNull();
  });

  it('Write 后对同文件做不同内容的 Edit → 不触发（常见正常迭代）', () => {
    expect(detector.trackSuccessfulWrite(write('/a.ts', 'const a = 1;'))).toBeNull();
    expect(detector.trackSuccessfulWrite(edit('/a.ts', 'const a = 1; const b = 2;'))).toBeNull();
  });

  it('不同文件各自独立计数，互不影响', () => {
    expect(detector.trackSuccessfulWrite(write('/a.ts', 'same'))).toBeNull();
    expect(detector.trackSuccessfulWrite(write('/b.ts', 'same'))).toBeNull();
  });

  it('非写工具 / 无 file_path 直接放过', () => {
    expect(detector.trackSuccessfulWrite({ id: '1', name: 'read_file', arguments: { file_path: '/a.ts' } } as ToolCall)).toBeNull();
    expect(detector.trackSuccessfulWrite({ id: '2', name: 'write_file', arguments: {} } as ToolCall)).toBeNull();
  });

  it('触发后清签名，下一次同签名重新计数（避免持续刷屏）', () => {
    detector.trackSuccessfulWrite(write('/a.ts', 'foo'));
    expect(detector.trackSuccessfulWrite(write('/a.ts', 'foo'))).not.toBeNull(); // 第2次触发并清零
    expect(detector.trackSuccessfulWrite(write('/a.ts', 'foo'))).toBeNull();     // 重新计数=1
    expect(detector.trackSuccessfulWrite(write('/a.ts', 'foo'))).not.toBeNull(); // 再次=2 触发
  });

  it('reset 清空成功写计数', () => {
    detector.trackSuccessfulWrite(write('/a.ts', 'foo'));
    detector.reset();
    expect(detector.trackSuccessfulWrite(write('/a.ts', 'foo'))).toBeNull();
  });
});
