// ============================================================================
// A1 收口的静态契约测试：全局记忆写入确认失败的文案只允许在一个共享模块
// （src/host/memory/directiveMemoryMessages.ts）里定义，其余位置一律 import 引用。
//
// 盲区自报纪律：本测试靠「哨兵片段」扫描 src/host 源码文本来找文案定义点。
// 如果扫描 0 命中（文案被改写、共享文件被搬走、哨兵过期），说明这道门已经
// 失效，必须报红让人来修扫描，绝不允许静默通过——静默通过的单源门等于没门。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const HOST_ROOT = path.resolve('src/host');
const SHARED_FILE = 'src/host/memory/directiveMemoryMessages.ts';

// 哨兵片段：三条共享文案里的固定子串。改文案时必须同步更新这里。
const SENTINELS = ['保存到全局记忆', '写入全局记忆需要你'];

// 工单点名的三个原硬编码位置，收口后必须改为引用共享模块。
const CALL_SITES = [
  'src/host/tools/toolExecutor.ts',
  'src/host/tools/dispatch/toolResolver.ts',
  'src/host/tools/modules/lightMemory/memoryWrite.ts',
];

function listTypeScriptFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

function findSentinelDefinitions(): string[] {
  return listTypeScriptFiles(HOST_ROOT)
    .filter((file) => {
      const text = fs.readFileSync(file, 'utf8');
      return SENTINELS.some((sentinel) => text.includes(sentinel));
    })
    .map((file) => path.relative(process.cwd(), file))
    .sort();
}

describe('全局记忆确认失败文案 — 单一来源静态契约', () => {
  it('哨兵扫描必须至少命中 1 个文件（0 命中 = 扫描失效，报红）', () => {
    const hits = findSentinelDefinitions();
    expect(
      hits.length,
      '哨兵扫描 0 命中：文案/路径/哨兵已失效，这道门不再能证明单一来源，必须修扫描',
    ).toBeGreaterThan(0);
  });

  it('文案只在共享模块里定义，其余位置不得出现副本', () => {
    expect(findSentinelDefinitions()).toEqual([SHARED_FILE]);
  });

  it.each(CALL_SITES)('%s 引用共享模块而不是自带文案', (callSite) => {
    const text = fs.readFileSync(path.resolve(callSite), 'utf8');
    expect(text).toMatch(/from ['"][^'"]*directiveMemoryMessages['"]/);
  });
});
