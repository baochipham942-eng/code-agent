// V2-B applyTweak IPC + 完整数据流 smoke
// 用法：npx tsx scripts/tweakWriter-smoke.mts
// 验证：通过 livePreview.ipc.ts 的 handler 真实触发 applyTweak，确认
//       IPC 层 → tweakWriter → 文件改写 → 读回反映正确，覆盖 5 类 mutation。

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerLivePreviewHandlers } from '../src/main/ipc/livePreview.ipc';
import { IPC_DOMAINS } from '../src/shared/ipc';
import type { IPCRequest, IPCResponse } from '../src/shared/ipc';
import type { TweakResult } from '../src/shared/livePreview/tweak';

let registered: ((event: unknown, req: IPCRequest) => Promise<IPCResponse> | IPCResponse) | null = null;

const fakeIpcMain = {
  handle(channel: string, handler: (event: unknown, req: IPCRequest) => Promise<IPCResponse> | IPCResponse) {
    if (channel === IPC_DOMAINS.LIVE_PREVIEW) registered = handler;
  },
  on() {},
  off() {},
  removeAllListeners() {},
} as unknown as Parameters<typeof registerLivePreviewHandlers>[0];

async function call(action: string, payload: unknown = {}): Promise<IPCResponse> {
  if (!registered) throw new Error('handler not registered');
  return Promise.resolve(registered({}, { action, payload } as IPCRequest));
}

function fail(label: string, msg: string): never {
  console.error(`FAIL [${label}]: ${msg}`);
  process.exit(1);
}

async function main() {
  registerLivePreviewHandlers(fakeIpcMain);
  if (!registered) fail('register', 'handler not registered');

  const dir = mkdtempSync(join(tmpdir(), 'tweak-smoke-'));
  const file = join(dir, 'Card.tsx');
  const fixture = `export const Card = () => (
  <div className="p-4 bg-blue-500 text-white rounded text-base text-left">
    Hello
  </div>
);
`;
  writeFileSync(file, fixture, 'utf-8');

  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  try {
    // <div 在 line 2, col 2 (0-indexed)
    const location = { file, line: 2, column: 2 };

    // [1] spacing p-4 → p-8
    const r1 = await call('applyTweak', {
      location,
      mutation: { kind: 'spacing', axis: 'p', value: 8 },
    });
    if (!r1.success) fail('1 spacing', JSON.stringify(r1.error));
    const d1 = r1.data as TweakResult;
    if (!d1.ok) fail('1 spacing', `reason=${d1.reason}`);
    console.log('[1] spacing p-4 → p-8:', d1.newClassName);
    if (!readFileSync(file, 'utf-8').includes('p-8')) fail('1 spacing', '文件未含 p-8');

    // [2] color bg-blue-500 → bg-red-600
    const r2 = await call('applyTweak', {
      location,
      mutation: { kind: 'color', target: 'bg', color: 'red', shade: 600 },
    });
    if (!r2.success || !(r2.data as TweakResult).ok) fail('2 color', JSON.stringify(r2));
    console.log('[2] bg → red-600:', (r2.data as { newClassName: string }).newClassName);

    // [3] fontSize text-base → text-2xl
    const r3 = await call('applyTweak', {
      location,
      mutation: { kind: 'fontSize', size: '2xl' },
    });
    if (!r3.success || !(r3.data as TweakResult).ok) fail('3 fontSize', JSON.stringify(r3));
    console.log('[3] fontSize → 2xl:', (r3.data as { newClassName: string }).newClassName);

    // [4] radius rounded → rounded-xl
    const r4 = await call('applyTweak', {
      location,
      mutation: { kind: 'radius', size: 'xl' },
    });
    if (!r4.success || !(r4.data as TweakResult).ok) fail('4 radius', JSON.stringify(r4));
    console.log('[4] radius → xl:', (r4.data as { newClassName: string }).newClassName);

    // [5] align text-left → text-center
    const r5 = await call('applyTweak', {
      location,
      mutation: { kind: 'align', axis: 'text', value: 'center' },
    });
    if (!r5.success || !(r5.data as TweakResult).ok) fail('5 align', JSON.stringify(r5));
    console.log('[5] align → center:', (r5.data as { newClassName: string }).newClassName);

    // [6] 验证最终文件状态全部累计落盘
    const final = readFileSync(file, 'utf-8');
    const expected = ['p-8', 'bg-red-600', 'text-white', 'rounded-xl', 'text-2xl', 'text-center'];
    for (const cls of expected) {
      if (!final.includes(cls)) fail('6 final state', `缺 ${cls}\n实际:\n${final}`);
    }
    console.log('[6] 累计 5 次 mutation 全部落盘 ✓');
    console.log('    最终 className:', final.match(/className="([^"]+)"/)?.[1]);

    // [7] 错误路径：表达式
    const cFile = join(dir, 'Expr.tsx');
    writeFileSync(cFile, `export const X = () => <div className={cls}>x</div>;\n`, 'utf-8');
    const r7 = await call('applyTweak', {
      location: { file: cFile, line: 1, column: 23 },
      mutation: { kind: 'spacing', axis: 'p', value: 8 },
    });
    if (!r7.success) fail('7 expression', `IPC 自身失败: ${JSON.stringify(r7.error)}`);
    const d7 = r7.data as TweakResult;
    if (d7.ok || d7.reason !== 'expression') fail('7 expression', `期望 expression, 拿到 ${JSON.stringify(d7)}`);
    console.log('[7] className={cls} → reason=expression ✓');

    // [8] 错误路径：相对路径被拒
    const r8 = await call('applyTweak', {
      location: { file: 'relative/path.tsx', line: 1, column: 0 },
      mutation: { kind: 'spacing', axis: 'p', value: 8 },
    });
    if (r8.success) fail('8 relative path', '相对路径应该被拒');
    if (r8.error?.code !== 'INVALID_ARGS') fail('8 relative path', `code=${r8.error?.code}`);
    console.log('[8] 相对路径拒绝 ✓');

    console.log('\n✓ V2-B applyTweak 8 case smoke 全过');
  } finally {
    cleanup();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('UNCAUGHT:', err);
  process.exit(1);
});
