import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as realOs from 'node:os';
import * as fs from 'fs';
import * as path from 'path';
import { isProtectedUserFolder, discoverAgentFiles } from '../../../src/host/context/agentsDiscovery';

const state = vi.hoisted(() => ({ home: '' }));

// agentsDiscovery 用默认 os.homedir() 识别受保护目录;注入可控 home 才能测跳过行为。
vi.mock('os', async (orig) => {
  const actual = (await orig()) as typeof import('os');
  const homedir = () => state.home || actual.homedir();
  return { ...actual, default: { ...actual, homedir }, homedir };
});

describe('isProtectedUserFolder', () => {
  const home = '/Users/tester';

  it('识别 ~/Desktop、~/Documents、~/Downloads 为受保护目录', () => {
    expect(isProtectedUserFolder(path.join(home, 'Desktop'), home)).toBe(true);
    expect(isProtectedUserFolder(path.join(home, 'Documents'), home)).toBe(true);
    expect(isProtectedUserFolder(path.join(home, 'Downloads'), home)).toBe(true);
  });

  it('普通子目录不算受保护', () => {
    expect(isProtectedUserFolder(path.join(home, 'projects'), home)).toBe(false);
    // 受保护目录的子目录本身不算(项目在 ~/Downloads 下时仍可扫描)
    expect(isProtectedUserFolder(path.join(home, 'Downloads', 'ai', 'code-agent'), home)).toBe(false);
  });
});

describe('discoverAgentFiles 家目录不下钻(避免各种敏感目录 TCC 弹窗)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(realOs.tmpdir(), 'agents-home-'));
    // 家目录根放一份 AGENTS.md,子目录各放一份(含敏感目录 + 普通目录)
    fs.writeFileSync(path.join(tmpHome, 'AGENTS.md'), '# home root agents\n');
    for (const d of ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'projects']) {
      fs.mkdirSync(path.join(tmpHome, d), { recursive: true });
      fs.writeFileSync(path.join(tmpHome, d, 'AGENTS.md'), `# agents in ${d}\n`);
    }
    state.home = tmpHome;
  });

  afterEach(() => {
    state.home = '';
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('工作目录是家目录时:只收本层 AGENTS.md,不下钻任何子目录(Desktop/Music 等一律不扫)', async () => {
    const result = await discoverAgentFiles(tmpHome);
    const dirs = result.files.map((f) => f.directory);
    expect(dirs).toContain('.'); // 家目录根这份仍收
    for (const d of ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'projects']) {
      expect(dirs).not.toContain(d);
    }
  });

  it('工作目录是普通项目目录时:子目录照常递归扫描(家目录护栏不误伤项目)', async () => {
    const project = path.join(tmpHome, 'projects');
    fs.mkdirSync(path.join(project, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(project, 'sub', 'AGENTS.md'), '# sub agents\n');
    const result = await discoverAgentFiles(project);
    const dirs = result.files.map((f) => f.directory);
    expect(dirs).toContain('.'); // project 根
    expect(dirs).toContain('sub'); // 子目录被扫到
  });
});
