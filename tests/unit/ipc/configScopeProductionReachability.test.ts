// ============================================================================
// 配置作用域面板生产可达性门（L8 N-L8-DEADRULES）
// ============================================================================
// buildConfigScopeSummary 把配置入口列给用户看；条目一旦显示为 active，就等于承诺
// 产品会读取它。2026-08-14 的 user-rules / project-rules 违反了这条承诺：面板按目录
// 存在性报「生效中」，生产链却从未加载 rulesLoader。
//
// 本门的盲区采取 fail-loud：PRODUCTION_READERS 是手工维护的跨模块读者表。新增面板项
// 而未登记，会由闭合断言点名报错；登记时还必须给出真实源码文件和关键读取锚点。
// 对外部 Claude Code CLI 的配置发现无法在本仓内展开实现，所以只证明 Neo 确实以工作区
// cwd 启动它，且没有用 --setting-sources 禁用项目配置；这是唯一明确标注的进程外边界。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildConfigScopeSummary } from '../../../src/host/ipc/workspaceConfigScope';

interface ProductionReaderEvidence {
  reader: string;
  source: string;
  anchors: RegExp[];
  forbidden?: RegExp[];
}

const ROOT = process.cwd();

const PRODUCTION_READERS: Record<string, ProductionReaderEvidence> = {
  'user-soul': {
    reader: 'loadSoul',
    source: 'src/host/prompts/soulLoader.ts',
    anchors: [/getUserConfigDir\(\)/, /'SOUL\.md'/, /readFileSync/],
  },
  'user-hooks': {
    reader: 'loadAllHooksConfig',
    source: 'src/host/hooks/configParser.ts',
    anchors: [/getHooksConfigPaths/, /CONFIG_DIR_NEW, 'hooks', 'hooks\.json'/, /loadHooksFromSource\(paths\.global/],
  },
  'user-mcp': {
    reader: 'loadMcpConfigFiles',
    source: 'src/host/mcp/mcpConfigFile.ts',
    anchors: [/getMcpScopedConfigPaths/, /readScopeFile\(paths\.user, 'user'\)/],
  },
  'user-skills': {
    reader: 'SkillDiscoveryService.doInitialize',
    source: 'src/host/services/skills/skillDiscoveryService.ts',
    anchors: [/getSkillsDir\(this\.workingDirectory\)/, /scanDirectory\(skillsDirs\.user\.new, 'user'\)/],
  },
  'user-agents': {
    reader: 'agentRegistry.buildMap',
    source: 'src/host/agent/agentRegistry.ts',
    anchors: [/getAgentsMdDir\(workingDir\)/, /scanDir\(dirs\.user, 'user'\)/],
  },
  'user-memory': {
    reader: 'loadMemoryIndex',
    source: 'src/host/lightMemory/indexLoader.ts',
    anchors: [/getUserConfigDir\(\), 'memory'/, /fs\.readFile\(indexPath/],
  },
  'project-profile': {
    reader: 'loadSoul',
    source: 'src/host/prompts/soulLoader.ts',
    anchors: [/getProjectConfigDir\(workingDirectory\)/, /'PROFILE\.md'/, /readFileSync/],
  },
  'project-hooks': {
    reader: 'loadAllHooksConfig',
    source: 'src/host/hooks/configParser.ts',
    anchors: [/getHooksConfigPaths/, /workingDirectory, CONFIG_DIR_NEW, 'hooks', 'hooks\.json'/, /loadHooksFromSource\(paths\.project/],
  },
  'project-settings': {
    reader: 'FolderTrustService.discoverDangerousItems',
    source: 'src/host/security/folderTrustService.ts',
    anchors: [/discoverDangerousItems/, /\['capabilities\.json', 'rules\.json', 'settings\.json'\]/, /'other-project-config'/],
  },
  'project-mcp': {
    reader: 'loadMcpConfigFiles',
    source: 'src/host/mcp/mcpConfigFile.ts',
    anchors: [/getMcpScopedConfigPaths/, /readScopeFile\(paths\.project, 'project'\)/],
  },
  'project-skills': {
    reader: 'SkillDiscoveryService.doInitialize',
    source: 'src/host/services/skills/skillDiscoveryService.ts',
    anchors: [/getSkillsDir\(this\.workingDirectory\)/, /scanDirectory\(skillsDirs\.project\.new, 'project'\)/],
  },
  'project-agents': {
    reader: 'agentRegistry.buildMap',
    source: 'src/host/agent/agentRegistry.ts',
    anchors: [/getAgentsMdDir\(workingDir\)/, /scanDir\(dirs\.project, 'project'\)/],
  },
  'project-agents-md': {
    reader: 'discoverAgentFiles',
    source: 'src/host/context/agentsDiscovery.ts',
    anchors: [/AGENT_FILES = \['AGENTS\.md', 'CLAUDE\.md'/, /fs\.readFile\(filePath/],
  },
  'project-claude-md': {
    reader: 'discoverAgentFiles',
    source: 'src/host/context/agentsDiscovery.ts',
    anchors: [/AGENT_FILES = \['AGENTS\.md', 'CLAUDE\.md'/, /fs\.readFile\(filePath/],
  },
  'local-mcp': {
    reader: 'loadMcpConfigFiles',
    source: 'src/host/mcp/mcpConfigFile.ts',
    anchors: [/getMcpScopedConfigPaths/, /readScopeFile\(paths\.local, 'local'\)/],
  },
  'local-claude-settings': {
    reader: 'ClaudeCodeAdapter.run → Claude Code workspace config discovery',
    source: 'src/host/services/agentEngine/claudeCodeAdapter.ts',
    anchors: [/class ClaudeCodeAdapter/, /spawn\(descriptor\.binaryPath, args/, /cwd,/],
    forbidden: [/['"]--setting-sources['"]/],
  },
  'runtime-app-settings': {
    reader: 'ConfigService.initialize',
    source: 'src/host/services/core/configService.ts',
    anchors: [/path\.join\(userDataPath, 'config\.json'\)/, /fs\.readFile\(this\.configPath/],
  },
  'runtime-db': {
    reader: 'DatabaseService',
    source: 'src/host/services/core/databaseService.ts',
    anchors: [/app\?\.getPath\?\.\('userData'\)/, /'code-agent\.db'/, /new Database\(this\.dbPath/],
  },
  'runtime-browser-profile': {
    reader: 'resolveManagedBrowserProfile',
    source: 'src/host/services/infra/browser/managedBrowserHelpers.ts',
    anchors: [/MANAGED_BROWSER_PERSISTENT_PROFILE_ID = 'managed-browser-profile'/, /profileDir: path\.join\(args\.userDataDir, profileId\)/],
  },
  'runtime-builtins': {
    reader: 'CloudConfigService.getConfig fallback',
    source: 'src/host/services/cloud/cloudConfigService.ts',
    anchors: [/getBuiltinConfig/, /return getBuiltinConfig\(\)/],
  },
};

describe('配置作用域面板生产可达性', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'config-scope-reachability-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  async function panelItemIds(): Promise<string[]> {
    const workingDirectory = path.join(rootDir, 'project');
    const summary = await buildConfigScopeSummary(workingDirectory, {
      userConfigDir: path.join(rootDir, 'user-config'),
      userDataDir: path.join(rootDir, 'user-data'),
    });
    return summary.layers.flatMap((layer) => layer.items.map((item) => item.id)).sort();
  }

  it('锚点有效：面板和生产读者表都有足够规模', async () => {
    const itemIds = await panelItemIds();
    expect(itemIds.length).toBeGreaterThanOrEqual(20);
    expect(Object.keys(PRODUCTION_READERS).length).toBeGreaterThanOrEqual(20);
  });

  it('闭合：生产读者表能无遗漏、无多余地重建面板全集', async () => {
    const itemIds = await panelItemIds();
    const mappedIds = Object.keys(PRODUCTION_READERS).sort();
    const unmapped = itemIds.filter((id) => !PRODUCTION_READERS[id]);
    const stale = mappedIds.filter((id) => !itemIds.includes(id));

    expect(
      unmapped,
      `这些配置项出现在面板里，却没有登记生产读者：${unmapped.join(', ')}。` +
        '请指认真实读取模块；如果没有，就从面板删除。',
    ).toEqual([]);
    expect(
      stale,
      `生产读者表含有面板已不存在的旧项：${stale.join(', ')}。`,
    ).toEqual([]);
    expect(mappedIds).toEqual(itemIds);
  });

  it('每个登记读者的源码文件和读取锚点都真实存在', async () => {
    const broken: string[] = [];

    for (const [itemId, evidence] of Object.entries(PRODUCTION_READERS)) {
      const sourcePath = path.join(ROOT, evidence.source);
      const sourceStat = await stat(sourcePath).catch(() => null);
      if (!sourceStat?.isFile()) {
        broken.push(`${itemId}: 读者文件不存在 ${evidence.source}`);
        continue;
      }

      const source = readFileSync(sourcePath, 'utf8');
      for (const anchor of evidence.anchors) {
        if (!anchor.test(source)) broken.push(`${itemId}: ${evidence.reader} 缺锚点 ${anchor}`);
      }
      for (const forbidden of evidence.forbidden ?? []) {
        if (forbidden.test(source)) broken.push(`${itemId}: ${evidence.reader} 命中禁用锚点 ${forbidden}`);
      }
    }

    expect(
      broken,
      `这些面板项登记的生产读者已断线：\n${broken.join('\n')}`,
    ).toEqual([]);
  });
});
