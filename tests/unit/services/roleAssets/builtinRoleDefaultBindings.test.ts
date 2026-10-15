// ============================================================================
// 出厂默认资料架种入测试（N-ROLE-DEFAULT-BINDINGS-SKILL）：
// 内置专家首启绑 1-3 个自带 skill（引用 only）、幂等、不覆盖用户绑定、注入块可见。
// 断言全部落在 installBuiltinRoles 的落盘产物上（公开入口），不 import 内部映射常量。
// N-ROLE-PACKS-PILOT3 追加：存量 5 角色 pinned sha256 字节不变 + 新 3 角色绑定核对。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
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

/**
 * 存量 5 角色的 pinned sha256（N-ROLE-PACKS-PILOT3 施工前 origin/main 42ceb34a6 的
 * agentMd 全文 / visual 规范化 JSON）。本批只允许追加新角色，存量角色字节不变；
 * 任一哈希漂移即说明有人顺手改了老角色，必须显式重 pin + 说明理由。
 */
const PREEXISTING_ROLE_SHA256: Readonly<Record<string, { agentMd: string; visual: string }>> = {
  数据分析师: {
    agentMd: 'c7255fd1b11630faa1bfe04d3bf8864d6af5df5eaa2c30404ecb00dbb813c2b3',
    visual: '71c55276ee1ae285b6dc24eadd3c5c08a751e01185be29b27fc6199fee9a455b',
  },
  牧之: {
    agentMd: '00924e86767b063d5c7595ce922c5b278ef1010e4ee43b66dbc8761a872e2916',
    visual: 'eecfbc6413f5aa352fb5b789beb001ceec8f7243de46e1e44117184c71b62c0b',
  },
  溯真: {
    agentMd: '96e5904b3c0f4d122d89726d76c35779fd936f6564e2c81a91786952a9a7c72a',
    visual: '26dd8d9046d188a68cedb82687953dc4da613a36b8f23fc931651720d7b5edcb',
  },
  青禾: {
    agentMd: '3e3bf52534cdb987f44768bacd12114e13df8d5331b4d87578d359a106478b8d',
    visual: '4453e375ee3fd869c3ec1f802d889a2251954acd340bb1328c7838f7a2d15851',
  },
  明镜: {
    agentMd: '9efe7399f40200d95b7532cd7d8c9925e361403d7f723f2f9cf7962ad2cd6e91',
    visual: '57cd8909a26fbb0eaee56eea21e830b0b2a2c6d492224fb0c095dbd03aae6b13',
  },
};

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** visual 的规范化形状：键序固定（与源字面量一致），tags/quickPrompts 保序 */
const visualCanon = (v: { icon: string; category: string; displayName: string; profession: string; tags: string[]; quickPrompts: string[] }) =>
  JSON.stringify(v, ['icon', 'category', 'displayName', 'profession', 'tags', 'quickPrompts']);

describe('installBuiltinRoles 出厂资料架种入', () => {
  it('① 每个在装内置角色绑 1-3 个随包分发的 skill（isBuiltinSkill 全过），且 = frontmatter skills 前 ≤3（防漂移）', async () => {
    await installBuiltinRoles();

    expect(BUILTIN_ROLES.length).toBe(8);
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

  it('① 存量 5 角色与施工前 origin/main 字节一致（pinned sha256：本批只追加，不改老角色）', () => {
    const preexistingIds = Object.keys(PREEXISTING_ROLE_SHA256);
    expect(preexistingIds.length).toBe(5);
    for (const id of preexistingIds) {
      const role = BUILTIN_ROLES.find((r) => r.id === id);
      expect(role, `${id} 不在装名册`).toBeDefined();
      const pinned = PREEXISTING_ROLE_SHA256[id]!;
      expect(sha256(role!.agentMd), `${id} agentMd 相对 origin/main 发生字节漂移`).toBe(pinned.agentMd);
      expect(sha256(visualCanon(role!.visual)), `${id} visual 相对 origin/main 发生字节漂移`).toBe(pinned.visual);
    }
  });

  it('① 本批新增 3 角色（持衡/记言/万卷）种入的默认绑定 = 各自约定的 skill 集（经 installBuiltinRoles 公开入口）', async () => {
    await installBuiltinRoles();

    const expected: Record<string, string[]> = {
      持衡: ['contract-review'],
      记言: ['meeting-summary'],
      万卷: ['literature-review', 'paper-distillation'],
    };
    for (const [id, skills] of Object.entries(expected)) {
      const bindings = JSON.parse(await readBindingsFile(id)) as Array<{ target: string }>;
      expect(bindings.map((b) => b.target), id).toEqual(skills);
    }
  });

  it('① 退役角色（研究员）已停发：安装后无角色目录、无默认绑定', async () => {
    await installBuiltinRoles();
    await expect(fs.access(getRoleBindingsPath('研究员'))).rejects.toThrow(/ENOENT/);
  });

  it('② 全新安装：各角色 bindings.json 只含 skill 引用（kind/mode，无 scope 键），不含 skill 正文', async () => {
    await installBuiltinRoles();

    for (const role of BUILTIN_ROLES) {
      const raw = await readBindingsFile(role.id);
      const bindings = JSON.parse(raw) as Array<Record<string, unknown>>;
      expect(bindings.map((b) => b.target), role.id).toEqual(expectedDefaultSkills(role.agentMd, role.id));
      for (const b of bindings) {
        expect(b.kind, role.id).toBe('skill');
        expect(b.mode, role.id).toBe('always');
        expect(b, role.id).not.toHaveProperty('scope');
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
    // 刻意写成带 scope 的存量形状（scope 下线前的真实历史文件），验证种入对老文件也逐字节不碰
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
