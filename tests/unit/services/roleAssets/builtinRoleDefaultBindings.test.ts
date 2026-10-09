// ============================================================================
// 出厂默认资料架种入测试（N-ROLE-DEFAULT-BINDINGS-SKILL）：
// 内置专家首启绑 1-3 个自带 skill（引用 only）、幂等、不覆盖用户绑定、注入块可见。
// 断言全部落在 installBuiltinRoles 的落盘产物上（公开入口），不 import 内部映射常量。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
  getAgentsMdDir: () => ({ user: path.join(mockConfigDir.dir, 'agents') }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { BUILTIN_ROLES, installBuiltinRoles } from '../../../../src/host/services/roleAssets/builtinRoles';
import { parseAgentMd } from '../../../../src/host/agent/hybrid/agentMdLoader';
import { getBuiltinSkill, isBuiltinSkill } from '../../../../src/host/services/skills/builtinSkills';
import { getRoleBindingsPath } from '../../../../src/host/services/roleAssets/roleContextBindings';
import { buildRoleContextBlock, ensureRoleAssetDirs } from '../../../../src/host/services/roleAssets/roleAssetService';

beforeEach(async () => {
  mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-default-bindings-test-'));
});

afterEach(async () => {
  await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
});

/** 该角色 agentMd frontmatter skills 列表的前 ≤3 个 = 出厂默认绑定的期望值 */
function expectedDefaultSkills(agentMd: string, id: string): string[] {
  return (parseAgentMd(agentMd, `${id}.md`)?.skills ?? []).slice(0, 3);
}

function readBindingsFile(roleId: string): Promise<string> {
  return fs.readFile(getRoleBindingsPath(roleId), 'utf-8');
}

describe('installBuiltinRoles 出厂资料架种入', () => {
  it('① 每个在装内置角色绑 1-3 个随包分发的 skill（isBuiltinSkill 全过），且 = frontmatter skills 前 ≤3（防漂移）', async () => {
    await installBuiltinRoles();

    expect(BUILTIN_ROLES.length).toBe(5);
    for (const role of BUILTIN_ROLES) {
      const bindings = JSON.parse(await readBindingsFile(role.id)) as Array<{ target: string }>;
      const names = bindings.map((b) => b.target);
      expect(names.length, `${role.id} 绑定数不在 1..3`).toBeGreaterThanOrEqual(1);
      expect(names.length, `${role.id} 绑定数不在 1..3`).toBeLessThanOrEqual(3);
      for (const name of names) {
        expect(isBuiltinSkill(name), `${role.id} -> ${name} 不是内置 skill`).toBe(true);
      }
      expect(names, role.id).toEqual(expectedDefaultSkills(role.agentMd, role.id));
    }
  });

  it('① 退役角色（研究员）已停发：安装后无角色目录、无默认绑定', async () => {
    await installBuiltinRoles();
    await expect(fs.access(getRoleBindingsPath('研究员'))).rejects.toThrow(/ENOENT/);
  });

  it('② 全新安装：各角色 bindings.json 只含 skill 引用（kind/mode/scope），不含 skill 正文', async () => {
    await installBuiltinRoles();

    for (const role of BUILTIN_ROLES) {
      const raw = await readBindingsFile(role.id);
      const bindings = JSON.parse(raw) as Array<Record<string, unknown>>;
      expect(bindings.map((b) => b.target), role.id).toEqual(expectedDefaultSkills(role.agentMd, role.id));
      for (const b of bindings) {
        expect(b.kind, role.id).toBe('skill');
        expect(b.mode, role.id).toBe('always');
        expect(b.scope, role.id).toBe('private');
        expect(typeof b.id, role.id).toBe('string');
        expect(typeof b.createdAt, role.id).toBe('number');
      }
      // 单一真源：绑定文件里不得出现任何 skill 的 promptContent 正文
      for (const name of expectedDefaultSkills(role.agentMd, role.id)) {
        const probe = getBuiltinSkill(name)!.promptContent.slice(0, 80);
        expect(probe.length, name).toBeGreaterThanOrEqual(40);
        expect(raw, `${role.id} 泄漏了 ${name} 的正文`).not.toContain(probe);
      }
    }
  });

  it('③ 幂等：第二次安装逐字节不改动已种入的 bindings.json', async () => {
    await installBuiltinRoles();
    const before = await readBindingsFile('牧之');
    await installBuiltinRoles();
    const after = await readBindingsFile('牧之');
    expect(after).toBe(before);
  });

  it('③ 已存在的用户绑定不被覆盖（哪怕只有一条）', async () => {
    await ensureRoleAssetDirs('牧之');
    const userBindings = [{
      id: 'user_b1', kind: 'file', target: '/tmp/notes.md', title: 'notes',
      mode: 'on_demand', scope: 'private', createdAt: 42,
    }];
    await fs.writeFile(getRoleBindingsPath('牧之'), JSON.stringify(userBindings, null, 2), 'utf-8');

    await installBuiltinRoles();

    expect(JSON.parse(await readBindingsFile('牧之'))).toEqual(userBindings);
  });

  it('③ 用户删空的 [] 保持为空（种入不复活）', async () => {
    await ensureRoleAssetDirs('青禾');
    await fs.writeFile(getRoleBindingsPath('青禾'), '[]', 'utf-8');

    await installBuiltinRoles();

    expect(JSON.parse(await readBindingsFile('青禾'))).toEqual([]);
  });

  it('④ 种入后 buildRoleContextBlock 的"你的资料架"逐个列出绑定技能（hermetic 临时数据目录）', async () => {
    await installBuiltinRoles();

    const suzhen = BUILTIN_ROLES.find((r) => r.id === '溯真')!;
    const block = await buildRoleContextBlock('溯真');
    expect(block).toContain('你的资料架');
    for (const name of expectedDefaultSkills(suzhen.agentMd, suzhen.id)) {
      expect(block).toContain(`${name}（技能）`);
    }
  });
});
