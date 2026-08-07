// ============================================================================
// 静态契约门：kind='text' 但确属交付物的产出点，必须带 role: 'deliverable' 显式标注
// ----------------------------------------------------------------------------
// 为什么要读源码文本而不是跑消费端：
// 角色轴的红线用例手写 role 进夹具，测的是「给了 deliverable 就进产物」——
// **测不到产出点到底有没有设这个值**。2026-08-07 实测：撤掉 notebookEdit 的 role
// 标注，红线用例 19/19 照样全绿。这道门就是补那个缺口的。
//
// kind: 'text' 的默认角色是 material（fail-closed，见 artifactRoleRegistry）。
// 以下产出点写的是真交付物，漏标 = 文件从产物列表里静默消失，用户丢东西。
//
// 断言锚在**赋值行**（^\s*role: 'deliverable',$），不用 toContain——产出点上方的
// 解释性注释里就有 "role"/"deliverable" 字样，toContain 会被注释喂饱，删了赋值照样绿。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROLE_ASSIGNMENT = /^\s*role: 'deliverable',$/m;

/** 产出真交付物但 kind 为 text 的工具——漏标 role 就会从产物里消失 */
const DELIVERABLE_TEXT_PRODUCERS = [
  'src/host/tools/modules/file/write.ts',
  'src/host/tools/modules/file/append.ts',
  'src/host/tools/modules/file/multiEdit.ts',
  'src/host/tools/modules/file/notebookEdit.ts',
] as const;

describe('交付物 role 标注静态契约', () => {
  // 零候选 fail-closed：清单被清空时这道门要报红，不能静默通过
  it('待检产出点清单非空', () => {
    expect(DELIVERABLE_TEXT_PRODUCERS.length).toBeGreaterThan(0);
  });

  it.each(DELIVERABLE_TEXT_PRODUCERS)('%s 带 role: \'deliverable\' 赋值', (relPath) => {
    const source = readFileSync(resolve(process.cwd(), relPath), 'utf8');

    // 前提断言：文件确实在产出 artifact。产出方式若被重构掉，这道门会失去意义，
    // 那时应当报红让人回来重新对齐，而不是继续对着一个不产 artifact 的文件绿。
    expect(source).toMatch(/create(Virtual|File)Artifact\(/);

    expect(source).toMatch(ROLE_ASSIGNMENT);
  });
});
