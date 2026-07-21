// ============================================================================
// Role Context Bindings Tests — E3 专家资料架：读写/校验/注入块/隔离
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { LibraryItem } from '../../../../src/shared/contract/library';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));
const mockLibrary = vi.hoisted(() => ({ items: new Map<string, unknown>() }));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
  getAgentsMdDir: () => ({ user: path.join(mockConfigDir.dir, 'agents') }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../../src/host/services/library/libraryService', () => ({
  getLibraryService: () => ({
    get: (id: string) => mockLibrary.items.get(id),
  }),
}));

import {
  addRoleBinding,
  buildRoleBindingsSection,
  getRoleBindingsPath,
  readRoleBindings,
  removeRoleBinding,
} from '../../../../src/host/services/roleAssets/roleContextBindings';
import { buildRoleContextBlock } from '../../../../src/host/services/roleAssets/roleAssetService';
import { ensureRoleAssetDirs } from '../../../../src/host/services/roleAssets/roleAssetService';

function makeLibraryItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 'lib_1',
    projectId: null,
    title: '产品语境卡',
    kind: 'upload',
    pathOrUri: '/data/library/global/context.md',
    summary: '协作者做 ToB SaaS，目标用户是运营',
    tags: ['素材'],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

let realFilePath: string;
let realDirPath: string;

beforeEach(async () => {
  mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-bindings-test-'));
  mockLibrary.items.clear();
  realFilePath = path.join(mockConfigDir.dir, 'sample.md');
  realDirPath = path.join(mockConfigDir.dir, 'templates');
  await fs.writeFile(realFilePath, 'x', 'utf-8');
  await fs.mkdir(realDirPath, { recursive: true });
});

afterEach(async () => {
  await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
});

describe('readRoleBindings / addRoleBinding / removeRoleBinding', () => {
  it('无文件返回空数组（空资料架也能工作）', async () => {
    expect(await readRoleBindings('牧之')).toEqual([]);
  });

  it('add→read 回环；路径类按盘上真实形态归一 kind', async () => {
    const fileBinding = await addRoleBinding('牧之', {
      kind: 'file', target: realFilePath, mode: 'on_demand', scope: 'private',
    }, 1000);
    // 目录传成 file 也会被 stat 归一成 folder
    const dirBinding = await addRoleBinding('牧之', {
      kind: 'file', target: realDirPath, mode: 'on_demand', scope: 'project',
    }, 2000);

    expect(fileBinding.kind).toBe('file');
    expect(fileBinding.title).toBe('sample.md');
    expect(dirBinding.kind).toBe('folder');

    const all = await readRoleBindings('牧之');
    expect(all).toHaveLength(2);
  });

  it('同 kind+target 幂等去重', async () => {
    const first = await addRoleBinding('牧之', { kind: 'file', target: realFilePath, mode: 'always', scope: 'private' }, 1000);
    const second = await addRoleBinding('牧之', { kind: 'file', target: realFilePath, mode: 'on_demand', scope: 'project' }, 2000);
    expect(second.id).toBe(first.id);
    expect(await readRoleBindings('牧之')).toHaveLength(1);
  });

  it('路径不存在拒绝绑定', async () => {
    await expect(
      addRoleBinding('牧之', { kind: 'file', target: path.join(mockConfigDir.dir, 'nope.md'), mode: 'always', scope: 'private' }),
    ).rejects.toThrow(/not found/i);
  });

  it('library_item 校验存在并回填标题；不存在拒绝', async () => {
    mockLibrary.items.set('lib_1', makeLibraryItem());
    const binding = await addRoleBinding('牧之', { kind: 'library_item', target: 'lib_1', mode: 'always', scope: 'private' });
    expect(binding.title).toBe('产品语境卡');
    await expect(
      addRoleBinding('牧之', { kind: 'library_item', target: 'lib_missing', mode: 'always', scope: 'private' }),
    ).rejects.toThrow(/not found/i);
  });

  it('remove 幂等；损坏 JSON / 非法条目降级为空', async () => {
    const b = await addRoleBinding('牧之', { kind: 'file', target: realFilePath, mode: 'always', scope: 'private' });
    await removeRoleBinding('牧之', b.id);
    await removeRoleBinding('牧之', b.id);
    expect(await readRoleBindings('牧之')).toEqual([]);

    await fs.writeFile(getRoleBindingsPath('牧之'), '{not json', 'utf-8');
    expect(await readRoleBindings('牧之')).toEqual([]);
    await fs.writeFile(getRoleBindingsPath('牧之'), JSON.stringify([{ id: 'x' }, { bogus: true }]), 'utf-8');
    expect(await readRoleBindings('牧之')).toEqual([]);
  });

  it('L1 隔离：角色各存各的文件，互不可见', async () => {
    await addRoleBinding('牧之', { kind: 'file', target: realFilePath, mode: 'always', scope: 'private' });
    expect(await readRoleBindings('溯真')).toEqual([]);
  });
});

describe('buildRoleBindingsSection', () => {
  it('always 带摘要、on_demand 仅列出；无绑定返回 null', async () => {
    expect(await buildRoleBindingsSection('牧之')).toBeNull();

    mockLibrary.items.set('lib_1', makeLibraryItem());
    await addRoleBinding('牧之', { kind: 'library_item', target: 'lib_1', mode: 'always', scope: 'private' });
    await addRoleBinding('牧之', { kind: 'file', target: realFilePath, mode: 'on_demand', scope: 'private' });

    const section = await buildRoleBindingsSection('牧之');
    expect(section).toContain('你的资料架');
    expect(section).toContain('产品语境卡');
    expect(section).toContain('摘要: 协作者做 ToB SaaS');
    expect(section).toContain('按需资料');
    expect(section).toContain('sample.md');
  });

  it('库条目已删的绑定不注入失效引用；全部失效时返回 null', async () => {
    mockLibrary.items.set('lib_1', makeLibraryItem());
    await addRoleBinding('牧之', { kind: 'library_item', target: 'lib_1', mode: 'always', scope: 'private' });
    mockLibrary.items.clear();
    expect(await buildRoleBindingsSection('牧之')).toBeNull();
  });
});

describe('buildRoleContextBlock 集成', () => {
  it('持久化角色的注入块包含资料架 section；另一角色不含（隔离）', async () => {
    await ensureRoleAssetDirs('牧之');
    await ensureRoleAssetDirs('溯真');
    await addRoleBinding('牧之', { kind: 'file', target: realFilePath, mode: 'always', scope: 'private' });

    const blockA = await buildRoleContextBlock('牧之');
    expect(blockA).toContain('你的资料架');
    expect(blockA).toContain('sample.md');

    const blockB = await buildRoleContextBlock('溯真');
    expect(blockB).not.toContain('你的资料架');
  });
});
