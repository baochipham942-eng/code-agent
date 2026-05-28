// ============================================================================
// projectSystemPrompt 加载器测试
// ============================================================================
// 覆盖:
//   - 文件不存在双 null
//   - 项目级 SYSTEM.md 命中 / 全局兜底
//   - 项目级覆盖全局级(短路)
//   - SYSTEM.md 和 APPEND_SYSTEM.md 互相独立
//   - 跨层组合(项目 append + 全局 custom)
//   - 空文件返回空字符串(非 null)
//   - workingDir 为空时只查全局
//   - sources provenance
//   - 读取错误降级(perm denied)不抛
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ⚠️ vi.mock 会被 hoist 到文件顶端;闭包捕获 homeTmp by reference,运行时取最新值
let homeTmp: string;

vi.mock('../../../src/main/config/configPaths', () => ({
  getUserConfigDir: (): string => path.join(homeTmp, '.code-agent'),
  getProjectConfigDir: (wd: string): string => path.join(wd, '.code-agent'),
}));

import {
  loadProjectSystemPrompt,
  SYSTEM_PROMPT_FILES,
} from '../../../src/main/prompts/projectSystemPrompt';

function writeFile(dir: string, name: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('loadProjectSystemPrompt', () => {
  let projectTmp: string;
  let projectCfgDir: string;
  let homeCfgDir: string;

  beforeEach(() => {
    homeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sysprompt-home-'));
    projectTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sysprompt-proj-'));
    projectCfgDir = path.join(projectTmp, '.code-agent');
    homeCfgDir = path.join(homeTmp, '.code-agent');
  });

  afterEach(() => {
    fs.rmSync(homeTmp, { recursive: true, force: true });
    fs.rmSync(projectTmp, { recursive: true, force: true });
  });

  it('两层都没文件 → custom + append 都是 null,sources 都 null', () => {
    const result = loadProjectSystemPrompt(projectTmp);
    expect(result.custom).toBeNull();
    expect(result.append).toBeNull();
    expect(result.sources.customPath).toBeNull();
    expect(result.sources.appendPath).toBeNull();
  });

  it('项目级 SYSTEM.md 命中 → custom = 内容 + customPath', () => {
    const filePath = writeFile(projectCfgDir, SYSTEM_PROMPT_FILES.REPLACE, 'project replace');
    const result = loadProjectSystemPrompt(projectTmp);
    expect(result.custom).toBe('project replace');
    expect(result.sources.customPath).toBe(filePath);
    expect(result.append).toBeNull();
  });

  it('只有全局 SYSTEM.md → custom = 全局内容 + customPath 指全局', () => {
    const filePath = writeFile(homeCfgDir, SYSTEM_PROMPT_FILES.REPLACE, 'global replace');
    const result = loadProjectSystemPrompt(projectTmp);
    expect(result.custom).toBe('global replace');
    expect(result.sources.customPath).toBe(filePath);
  });

  it('项目级覆盖全局级(短路,不合并)', () => {
    writeFile(homeCfgDir, SYSTEM_PROMPT_FILES.REPLACE, 'global replace');
    const projectPath = writeFile(projectCfgDir, SYSTEM_PROMPT_FILES.REPLACE, 'project replace');
    const result = loadProjectSystemPrompt(projectTmp);
    expect(result.custom).toBe('project replace');
    expect(result.sources.customPath).toBe(projectPath);
  });

  it('APPEND_SYSTEM.md 独立于 SYSTEM.md(只有 APPEND 时 custom = null)', () => {
    const appendPath = writeFile(projectCfgDir, SYSTEM_PROMPT_FILES.APPEND, 'append only');
    const result = loadProjectSystemPrompt(projectTmp);
    expect(result.custom).toBeNull();
    expect(result.append).toBe('append only');
    expect(result.sources.appendPath).toBe(appendPath);
  });

  it('SYSTEM.md + APPEND_SYSTEM.md 同时存在 → 两字段都填', () => {
    const customPath = writeFile(projectCfgDir, SYSTEM_PROMPT_FILES.REPLACE, 'replace text');
    const appendPath = writeFile(projectCfgDir, SYSTEM_PROMPT_FILES.APPEND, 'append text');
    const result = loadProjectSystemPrompt(projectTmp);
    expect(result.custom).toBe('replace text');
    expect(result.append).toBe('append text');
    expect(result.sources.customPath).toBe(customPath);
    expect(result.sources.appendPath).toBe(appendPath);
  });

  it('跨层组合:项目 append + 全局 custom 各自命中各自的层', () => {
    const globalCustom = writeFile(homeCfgDir, SYSTEM_PROMPT_FILES.REPLACE, 'global replace');
    const projectAppend = writeFile(projectCfgDir, SYSTEM_PROMPT_FILES.APPEND, 'project append');
    const result = loadProjectSystemPrompt(projectTmp);
    expect(result.custom).toBe('global replace');
    expect(result.append).toBe('project append');
    expect(result.sources.customPath).toBe(globalCustom);
    expect(result.sources.appendPath).toBe(projectAppend);
  });

  it('空文件存在 → content = "" 不是 null,sources 仍填', () => {
    const emptyPath = writeFile(projectCfgDir, SYSTEM_PROMPT_FILES.REPLACE, '');
    const result = loadProjectSystemPrompt(projectTmp);
    expect(result.custom).toBe('');
    expect(result.sources.customPath).toBe(emptyPath);
  });

  it('workingDir 为空字符串 → 只查全局', () => {
    writeFile(projectCfgDir, SYSTEM_PROMPT_FILES.REPLACE, 'project never reached');
    const globalPath = writeFile(homeCfgDir, SYSTEM_PROMPT_FILES.REPLACE, 'global only');
    const result = loadProjectSystemPrompt('');
    expect(result.custom).toBe('global only');
    expect(result.sources.customPath).toBe(globalPath);
  });

  it('文件读不出来(权限/IO)→ 静默跳到下一候选,不抛', () => {
    // 项目级创建文件,然后 chmod 000 模拟权限拒绝
    const projectPath = writeFile(projectCfgDir, SYSTEM_PROMPT_FILES.REPLACE, 'project content');
    const globalPath = writeFile(homeCfgDir, SYSTEM_PROMPT_FILES.REPLACE, 'global fallback');
    try {
      fs.chmodSync(projectPath, 0o000);
      // 在 root 上 chmod 不一定挡住读;先确认非 root
      // 如果 reader 拿不到内容,应该 fallback 到 global
      const result = loadProjectSystemPrompt(projectTmp);
      // 要么读到 project(root / 缓存权限失效),要么 fallback 到 global
      expect([projectPath, globalPath]).toContain(result.sources.customPath);
      // 关键:不应该抛
      expect(result.custom).not.toBeNull();
    } finally {
      fs.chmodSync(projectPath, 0o644); // 恢复以便 cleanup
    }
  });

  it('SYSTEM_PROMPT_FILES 常量用的文件名跟实际查找一致', () => {
    expect(SYSTEM_PROMPT_FILES.REPLACE).toBe('SYSTEM.md');
    expect(SYSTEM_PROMPT_FILES.APPEND).toBe('APPEND_SYSTEM.md');
    expect(SYSTEM_PROMPT_FILES.FULL_REPLACE).toBe('FULL_SYSTEM.md');
  });

  // --------------------------------------------------------------------------
  // FULL_SYSTEM.md (D 风险闭环):用户要完全接管 system prompt,跳过所有默认层
  // --------------------------------------------------------------------------

  it('项目级 FULL_SYSTEM.md 命中 → fullReplace = 内容 + fullReplacePath', () => {
    const filePath = writeFile(projectCfgDir, SYSTEM_PROMPT_FILES.FULL_REPLACE, 'full takeover');
    const result = loadProjectSystemPrompt(projectTmp);
    expect(result.fullReplace).toBe('full takeover');
    expect(result.sources.fullReplacePath).toBe(filePath);
    expect(result.custom).toBeNull();
    expect(result.append).toBeNull();
  });

  it('只有全局 FULL_SYSTEM.md → fullReplace = 全局内容 + 路径指全局', () => {
    const filePath = writeFile(homeCfgDir, SYSTEM_PROMPT_FILES.FULL_REPLACE, 'global full');
    const result = loadProjectSystemPrompt(projectTmp);
    expect(result.fullReplace).toBe('global full');
    expect(result.sources.fullReplacePath).toBe(filePath);
  });

  it('项目级 FULL_SYSTEM.md 覆盖全局级(短路,不合并)', () => {
    writeFile(homeCfgDir, SYSTEM_PROMPT_FILES.FULL_REPLACE, 'global full');
    const projectPath = writeFile(projectCfgDir, SYSTEM_PROMPT_FILES.FULL_REPLACE, 'project full');
    const result = loadProjectSystemPrompt(projectTmp);
    expect(result.fullReplace).toBe('project full');
    expect(result.sources.fullReplacePath).toBe(projectPath);
  });

  it('三种文件同时存在 → 三个字段独立填充(消费者负责优先级)', () => {
    const customPath = writeFile(projectCfgDir, SYSTEM_PROMPT_FILES.REPLACE, 'replace');
    const appendPath = writeFile(projectCfgDir, SYSTEM_PROMPT_FILES.APPEND, 'append');
    const fullPath = writeFile(projectCfgDir, SYSTEM_PROMPT_FILES.FULL_REPLACE, 'full');
    const result = loadProjectSystemPrompt(projectTmp);
    expect(result.custom).toBe('replace');
    expect(result.append).toBe('append');
    expect(result.fullReplace).toBe('full');
    expect(result.sources.customPath).toBe(customPath);
    expect(result.sources.appendPath).toBe(appendPath);
    expect(result.sources.fullReplacePath).toBe(fullPath);
  });

  it('两层都没文件 → fullReplace + fullReplacePath 都是 null', () => {
    const result = loadProjectSystemPrompt(projectTmp);
    expect(result.fullReplace).toBeNull();
    expect(result.sources.fullReplacePath).toBeNull();
  });

  it('FULL_SYSTEM.md 为空文件 → fullReplace = "" 不是 null', () => {
    const emptyPath = writeFile(projectCfgDir, SYSTEM_PROMPT_FILES.FULL_REPLACE, '');
    const result = loadProjectSystemPrompt(projectTmp);
    expect(result.fullReplace).toBe('');
    expect(result.sources.fullReplacePath).toBe(emptyPath);
  });
});
