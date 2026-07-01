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

describe('discoverAgentFiles 跳过受保护用户目录', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(realOs.tmpdir(), 'agents-home-'));
    for (const d of ['Desktop', 'Documents', 'Downloads', 'projects']) {
      fs.mkdirSync(path.join(tmpHome, d), { recursive: true });
      fs.writeFileSync(path.join(tmpHome, d, 'AGENTS.md'), `# agents in ${d}\n`);
    }
    state.home = tmpHome;
  });

  afterEach(() => {
    state.home = '';
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('从家目录扫描时,不收录 Desktop/Documents/Downloads 里的 AGENTS.md(不 readdir 它们)', async () => {
    const result = await discoverAgentFiles(tmpHome);
    const dirs = result.files.map((f) => f.directory);
    expect(dirs).not.toContain('Desktop');
    expect(dirs).not.toContain('Documents');
    expect(dirs).not.toContain('Downloads');
    // 普通目录仍被扫描
    expect(dirs).toContain('projects');
  });
});
