// ============================================================================
// Workspace config-scope / safety-scan 分析 — 从 workspace.ipc.ts 拆出（零行为改动）
// CLAUDE.md 等配置层级汇总 + 安全扫描；registerWorkspaceHandlers 调 handleGetConfigScope。
// ============================================================================

import path from 'path';
import { app } from '../platform';
import type {
  ConfigSafetyRiskKind,
  ConfigSafetyScanFinding,
  ConfigSafetyScanSummary,
  ConfigSafetyScanTarget,
  ConfigSafetySeverity,
  ConfigScopeItem,
  ConfigScopeItemKind,
  ConfigScopeItemStatus,
  ConfigScopeLayer,
  ConfigScopeLayerId,
  ConfigScopeSummary,
  ConfigWriteRecommendation,
} from '../../shared/contract/configScope';
import type { AgentApplicationService } from '../../shared/contract/appService';
import {
  getAgentsMdDir,
  getMcpScopedConfigPaths,
  getProjectConfigDir,
  getRulesDir,
  getSkillsDir,
  getUserConfigDir,
} from '../config/configPaths';

interface BuildConfigScopeOptions {
  userConfigDir?: string;
  userDataDir?: string;
}

interface ConfigScopeItemInput {
  id: string;
  label: string;
  description: string;
  path: string;
  kind: ConfigScopeItemKind;
  active?: boolean;
  private?: boolean;
  detail?: string;
  warning?: string;
}

interface SafetyScanTargetInput {
  id: string;
  label: string;
  path: string;
  kind: 'file' | 'directory';
}

interface SafetyPatternRule {
  kind: ConfigSafetyRiskKind;
  severity: ConfigSafetySeverity;
  label: string;
  regexes: RegExp[];
  detail: (count: number) => string;
  recommendation: string;
}

const CONFIG_WRITE_RECOMMENDATIONS: ConfigWriteRecommendation[] = [
  {
    id: 'identity-memory',
    label: '身份、记忆、个人偏好',
    description: '长期称呼、个人习惯、私人记忆和跨项目默认行为。',
    recommendedLayer: 'user',
    shareability: 'private',
    teamShareable: false,
    guidance: '写到 User 层；不要放进项目模板或团队仓库。',
  },
  {
    id: 'project-profile-rules',
    label: '项目画像、规则、团队约定',
    description: '项目事实、技术栈、测试命令、路径规则和协作约束。',
    recommendedLayer: 'project',
    shareability: 'team-shareable',
    teamShareable: true,
    guidance: '写到 Project 层；提交前确认没有个人路径、账号和 token。',
  },
  {
    id: 'mcp-shared-template',
    label: 'MCP 共享模板',
    description: '团队都需要的 MCP server 名称、命令、基础参数和禁用态草稿。',
    recommendedLayer: 'project',
    shareability: 'team-shareable',
    teamShareable: true,
    guidance: '模板可以进 Project 层；密钥、私有端点和机器端口放到 Local/User。',
  },
  {
    id: 'mcp-private-overrides',
    label: 'MCP token、端口、私有 endpoint',
    description: '个人凭证、本机路径、localhost、内网地址和私有服务参数。',
    recommendedLayer: 'local',
    shareability: 'local-only',
    teamShareable: false,
    guidance: '写到 Local 覆盖文件或 User 层；保持在 gitignore 内。',
  },
  {
    id: 'hooks-automation',
    label: 'hooks 与自动化命令',
    description: 'lint、typecheck、格式化、审计和本机辅助脚本。',
    recommendedLayer: 'project',
    shareability: 'team-shareable',
    teamShareable: true,
    guidance: '团队验证动作放 Project hooks；个人自动化放 User hooks，本机路径放 Local。',
  },
  {
    id: 'skills-agents',
    label: 'skills、agents、工作流模板',
    description: '可复用技能、agent 定义、团队工作流和能力模板。',
    recommendedLayer: 'project',
    shareability: 'team-shareable',
    teamShareable: true,
    guidance: '团队共用模板放 Project；私人方法、账号和本机路径留在 User/Local。',
  },
  {
    id: 'ui-preferences',
    label: 'UI 偏好和最近目录',
    description: '窗口偏好、最近工作区、浏览器 profile、cache 和本地数据库。',
    recommendedLayer: 'runtime',
    shareability: 'runtime-private',
    teamShareable: false,
    guidance: '让 Settings UI 写 Runtime；不要复制到项目配置。',
  },
];

const SAFETY_SCAN_RULES: SafetyPatternRule[] = [
  {
    kind: 'absolute_path',
    severity: 'warning',
    label: '本机绝对路径',
    regexes: [
      /(^|[\s"'=:[{(,])(?:~\/|\/(?:Users|home|var|tmp|opt|etc|Volumes|Applications)\b|[A-Za-z]:\\)/,
    ],
    detail: (count) => `发现 ${count} 处本机绝对路径引用。`,
    recommendation: '共享前改成相对路径、环境变量，或移到 Local/User 层。',
  },
  {
    kind: 'secret',
    severity: 'critical',
    label: '疑似 secret',
    regexes: [
      /\b(api[_-]?key|token|secret|password|passwd|credential|authorization|cookie|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token)\b["']?\s*[:=]/i,
      /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
      /\b(sk|rk|pk|ghp|gho|github_pat|xox[baprs])[_-][A-Za-z0-9_=-]{12,}/i,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ],
    detail: (count) => `发现 ${count} 处疑似凭证或敏感字段。`,
    recommendation: '不要共享原值；改用环境变量、secretRef，或放入本机私有配置。',
  },
  {
    kind: 'private_endpoint',
    severity: 'warning',
    label: 'localhost / 内网 endpoint',
    regexes: [
      /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|[^/\s"']+\.local)(?::\d+)?/i,
    ],
    detail: (count) => `发现 ${count} 处本机或内网 endpoint。`,
    recommendation: '团队共享模板里保留占位符；真实地址放 Local 覆盖。',
  },
  {
    kind: 'dangerous_shell',
    severity: 'critical',
    label: '危险 shell 模式',
    regexes: [
      /(^|\s)rm\s+-rf(\s|$)/i,
      /\bsudo\b/i,
      /\bchmod\s+777\b/i,
      /\bcurl\b[^|;\n]*\|\s*(sh|bash)\b/i,
      /\bwget\b[^|;\n]*\|\s*(sh|bash)\b/i,
      /\bgit\s+reset\s+--hard\b/i,
      /\bdd\s+if=/i,
      /\bmkfs\b/i,
      /\bdiskutil\s+erase\b/i,
      /\blaunchctl\b/i,
      /\bkillall\b/i,
      /\bpkill\b/i,
      /\bdocker\s+system\s+prune\b/i,
    ],
    detail: (count) => `发现 ${count} 处危险 shell 命令模式。`,
    recommendation: '共享前改成受限脚本、显式确认动作，或只保留在个人 hooks。',
  },
];

const SAFETY_SCAN_TEXT_EXTENSIONS = new Set([
  '.json',
  '.md',
  '.markdown',
  '.yml',
  '.yaml',
  '.toml',
  '.js',
  '.ts',
  '.sh',
  '.txt',
]);
const MAX_SAFETY_SCAN_FILES = 60;
const MAX_SAFETY_SCAN_BYTES = 128 * 1024;

async function pathStatus(targetPath: string, kind: ConfigScopeItemKind): Promise<{
  exists: boolean;
  detail?: string;
}> {
  if (kind === 'runtime') {
    return { exists: true };
  }

  try {
    const stat = await import('fs/promises').then((fs) => fs.stat(targetPath));
    if (kind === 'directory') {
      if (!stat.isDirectory()) return { exists: false };
      try {
        const fs = await import('fs/promises');
        const entries = await fs.readdir(targetPath);
        return { exists: true, detail: `${entries.length} 项` };
      } catch {
        return { exists: true };
      }
    }
    return { exists: stat.isFile() };
  } catch {
    return { exists: false };
  }
}

async function hasJsonKey(filePath: string, key: string): Promise<boolean> {
  try {
    const fs = await import('fs/promises');
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(parsed, key);
  } catch {
    return false;
  }
}

function resolveStatus(exists: boolean, active: boolean, warning?: string): ConfigScopeItemStatus {
  if (warning) return 'warning';
  if (!exists) return 'missing';
  return active ? 'active' : 'present';
}

async function statOrNull(targetPath: string): Promise<Awaited<ReturnType<typeof import('fs/promises').stat>> | null> {
  try {
    const fs = await import('fs/promises');
    return await fs.stat(targetPath);
  } catch {
    return null;
  }
}

function normalizeScanPath(workingDirectory: string, targetPath: string): string {
  const relativePath = path.relative(workingDirectory, targetPath);
  if (!relativePath || relativePath === '') return '.';
  if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) return relativePath;
  return targetPath;
}

function shouldScanSafetyFile(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  if (basename === 'skill.md' || basename === 'agents.md' || basename === 'claude.md') return true;
  return SAFETY_SCAN_TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function collectSafetyFiles(
  directoryPath: string,
  files: string[] = [],
  depth = 0,
): Promise<string[]> {
  if (files.length >= MAX_SAFETY_SCAN_FILES || depth > 2) {
    return files;
  }

  try {
    const fs = await import('fs/promises');
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_SAFETY_SCAN_FILES) break;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await collectSafetyFiles(entryPath, files, depth + 1);
      } else if (entry.isFile() && shouldScanSafetyFile(entryPath)) {
        files.push(entryPath);
      }
    }
  } catch {
    return files;
  }

  return files;
}

function findMatchingLines(content: string, regexes: RegExp[]): number[] {
  const hits: number[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (regexes.some((regex) => regex.test(line))) {
      hits.push(index + 1);
    }
  });
  return hits;
}

function buildSafetyFinding(
  rule: SafetyPatternRule,
  workingDirectory: string,
  filePath: string,
  targetLabel: string,
  lineNumbers: number[],
): ConfigSafetyScanFinding {
  const target = normalizeScanPath(workingDirectory, filePath);
  const visibleLocations = lineNumbers.slice(0, 6).map((line) => `${target}:${line}`);
  if (lineNumbers.length > visibleLocations.length) {
    visibleLocations.push(`+${lineNumbers.length - visibleLocations.length} more`);
  }

  return {
    id: `${rule.kind}:${target}:${lineNumbers.slice(0, 3).join(',')}`,
    kind: rule.kind,
    severity: rule.severity,
    label: rule.label,
    target,
    targetLabel,
    locations: visibleLocations,
    detail: rule.detail(lineNumbers.length),
    recommendation: rule.recommendation,
  };
}

async function scanSafetyFile(
  workingDirectory: string,
  filePath: string,
  targetLabel: string,
): Promise<ConfigSafetyScanFinding[]> {
  const fileStat = await statOrNull(filePath);
  if (!fileStat?.isFile()) return [];

  try {
    const fs = await import('fs/promises');
    const raw = await fs.readFile(filePath, 'utf-8');
    const content = raw.length > MAX_SAFETY_SCAN_BYTES
      ? raw.slice(0, MAX_SAFETY_SCAN_BYTES)
      : raw;
    return SAFETY_SCAN_RULES
      .map((rule) => {
        const lineNumbers = findMatchingLines(content, rule.regexes);
        return lineNumbers.length > 0
          ? buildSafetyFinding(rule, workingDirectory, filePath, targetLabel, lineNumbers)
          : null;
      })
      .filter((finding): finding is ConfigSafetyScanFinding => finding !== null);
  } catch {
    return [];
  }
}

async function scanSafetyTarget(
  workingDirectory: string,
  target: SafetyScanTargetInput,
): Promise<{ target: ConfigSafetyScanTarget; findings: ConfigSafetyScanFinding[] }> {
  const targetStat = await statOrNull(target.path);
  const exists = target.kind === 'directory'
    ? Boolean(targetStat?.isDirectory())
    : Boolean(targetStat?.isFile());
  const files = exists
    ? target.kind === 'directory'
      ? await collectSafetyFiles(target.path)
      : [target.path]
    : [];

  const findings: ConfigSafetyScanFinding[] = [];
  for (const filePath of files) {
    findings.push(...await scanSafetyFile(workingDirectory, filePath, target.label));
  }

  return {
    target: {
      id: target.id,
      label: target.label,
      path: target.path,
      relativePath: normalizeScanPath(workingDirectory, target.path),
      kind: target.kind,
      exists,
      scannedFiles: files.length,
    },
    findings,
  };
}

async function buildHooksLocationFindings(
  workingDirectory: string,
  projectConfigDir: string,
): Promise<ConfigSafetyScanFinding[]> {
  const findings: ConfigSafetyScanFinding[] = [];
  const settingsPath = path.join(projectConfigDir, 'settings.json');
  if (await hasJsonKey(settingsPath, 'hooks')) {
    const target = normalizeScanPath(workingDirectory, settingsPath);
    findings.push({
      id: `hooks_location:${target}:settings`,
      kind: 'hooks_location',
      severity: 'warning',
      label: 'hooks 写在 settings.json',
      target,
      targetLabel: 'Project settings',
      locations: [target],
      detail: 'settings.json 内含 hooks 字段，但当前 hook parser 读取 hooks/hooks.json。',
      recommendation: '把项目 hooks 移到 .code-agent/hooks/hooks.json，settings.json 只保留非 hooks 设置。',
    });
  }

  const rootHooksPath = path.join(projectConfigDir, 'hooks.json');
  const rootHooksStat = await statOrNull(rootHooksPath);
  if (rootHooksStat?.isFile()) {
    const target = normalizeScanPath(workingDirectory, rootHooksPath);
    findings.push({
      id: `hooks_location:${target}:root`,
      kind: 'hooks_location',
      severity: 'warning',
      label: 'hooks.json 位置不符合当前约定',
      target,
      targetLabel: 'Project hooks',
      locations: [target],
      detail: '发现 .code-agent/hooks.json；当前项目 hooks 约定位置是 .code-agent/hooks/hooks.json。',
      recommendation: '把文件移到 .code-agent/hooks/hooks.json，避免团队以为它已经生效。',
    });
  }

  return findings;
}

async function buildConfigSafetyScanSummary(
  workingDirectory: string | null,
  projectConfigDir: string | null,
): Promise<ConfigSafetyScanSummary> {
  if (!workingDirectory || !projectConfigDir) {
    return {
      status: 'no_workspace',
      scannedAt: Date.now(),
      workingDirectory,
      totalFindings: 0,
      criticalCount: 0,
      warningCount: 0,
      infoCount: 0,
      targets: [],
      findings: [],
    };
  }

  const scanTargets: SafetyScanTargetInput[] = [
    { id: 'project-mcp', label: 'Project MCP', path: path.join(projectConfigDir, 'mcp.json'), kind: 'file' },
    { id: 'project-hooks', label: 'Project hooks', path: path.join(projectConfigDir, 'hooks', 'hooks.json'), kind: 'file' },
    { id: 'project-settings', label: 'Project settings', path: path.join(projectConfigDir, 'settings.json'), kind: 'file' },
    { id: 'project-skills', label: 'Project skills', path: path.join(projectConfigDir, 'skills'), kind: 'directory' },
    { id: 'misplaced-hooks', label: 'Misplaced hooks', path: path.join(projectConfigDir, 'hooks.json'), kind: 'file' },
  ];

  const targets: ConfigSafetyScanTarget[] = [];
  const findings: ConfigSafetyScanFinding[] = [];
  for (const target of scanTargets) {
    const result = await scanSafetyTarget(workingDirectory, target);
    targets.push(result.target);
    findings.push(...result.findings);
  }
  findings.push(...await buildHooksLocationFindings(workingDirectory, projectConfigDir));

  const criticalCount = findings.filter((finding) => finding.severity === 'critical').length;
  const warningCount = findings.filter((finding) => finding.severity === 'warning').length;
  const infoCount = findings.filter((finding) => finding.severity === 'info').length;

  return {
    status: findings.length > 0 ? 'needs_review' : 'clear',
    scannedAt: Date.now(),
    workingDirectory,
    totalFindings: findings.length,
    criticalCount,
    warningCount,
    infoCount,
    targets,
    findings,
  };
}

async function buildItem(input: ConfigScopeItemInput): Promise<ConfigScopeItem> {
  const { exists, detail } = await pathStatus(input.path, input.kind);
  const active = input.active ?? exists;
  return {
    id: input.id,
    label: input.label,
    description: input.description,
    path: input.path,
    kind: input.kind,
    exists,
    active,
    private: input.private ?? false,
    status: resolveStatus(exists, active, input.warning),
    detail: detail ?? input.detail,
    warning: input.warning,
  };
}

function buildLayer(
  id: ConfigScopeLayerId,
  label: string,
  description: string,
  pathLabel: string,
  items: ConfigScopeItem[],
): ConfigScopeLayer {
  return {
    id,
    label,
    description,
    pathLabel,
    items,
    presentCount: items.filter((item) => item.exists).length,
    activeCount: items.filter((item) => item.exists && item.active).length,
    warningCount: items.filter((item) => item.status === 'warning').length,
  };
}

export async function buildConfigScopeSummary(
  workingDirectory: string | null,
  options: BuildConfigScopeOptions = {},
): Promise<ConfigScopeSummary> {
  const userConfigDir = options.userConfigDir ?? getUserConfigDir();
  const userDataDir = options.userDataDir ?? app.getPath('userData');
  const projectConfigDir = workingDirectory ? getProjectConfigDir(workingDirectory) : null;
  const mcpPaths = getMcpScopedConfigPaths(workingDirectory ?? undefined);
  const skillsDirs = getSkillsDir(workingDirectory ?? undefined);
  const agentDirs = getAgentsMdDir(workingDirectory ?? undefined);
  const rulesDirs = getRulesDir(workingDirectory ?? undefined);
  const safetyScan = await buildConfigSafetyScanSummary(workingDirectory, projectConfigDir);

  const userItems = await Promise.all([
    buildItem({
      id: 'user-soul',
      label: 'SOUL.md',
      description: '跨项目人格、称呼、沟通方式和长期偏好。',
      path: path.join(userConfigDir, 'SOUL.md'),
      kind: 'file',
      private: true,
    }),
    buildItem({
      id: 'user-hooks',
      label: '全局 hooks',
      description: '所有工作区都会继承的个人自动化。',
      path: path.join(userConfigDir, 'hooks', 'hooks.json'),
      kind: 'file',
      private: true,
    }),
    buildItem({
      id: 'user-mcp',
      label: '用户 MCP',
      description: '跨项目可用的个人 MCP server。',
      path: mcpPaths.user,
      kind: 'file',
      private: true,
    }),
    buildItem({
      id: 'user-skills',
      label: '个人 skills',
      description: '当前用户安装的技能库。',
      path: skillsDirs.user.new,
      kind: 'directory',
      private: true,
    }),
    buildItem({
      id: 'user-agents',
      label: '个人 agents',
      description: '当前用户的自定义 agent 定义。',
      path: agentDirs.user,
      kind: 'directory',
      private: true,
    }),
    buildItem({
      id: 'user-rules',
      label: '个人 rules',
      description: '跨项目路径规则。',
      path: rulesDirs.user,
      kind: 'directory',
      private: true,
    }),
    buildItem({
      id: 'user-memory',
      label: 'Light Memory',
      description: '用户记忆、画像、纠偏和近期会话索引。',
      path: path.join(userConfigDir, 'memory'),
      kind: 'directory',
      private: true,
    }),
  ]);

  const projectSettingsPath = projectConfigDir ? path.join(projectConfigDir, 'settings.json') : '';
  const projectSettingsHasHooks = projectSettingsPath
    ? await hasJsonKey(projectSettingsPath, 'hooks')
    : false;
  const projectSettingsWarning = projectSettingsHasHooks
    ? '这里的 hooks 不会被当前 hook parser 读取；请使用 .code-agent/hooks/hooks.json。'
    : undefined;

  const projectItems = workingDirectory && projectConfigDir ? await Promise.all([
    buildItem({
      id: 'project-profile',
      label: 'PROFILE.md',
      description: '项目定位、技术约束、测试命令和团队协作约定。',
      path: path.join(projectConfigDir, 'PROFILE.md'),
      kind: 'file',
    }),
    buildItem({
      id: 'project-hooks',
      label: '项目 hooks',
      description: '项目统一的 lint、typecheck、验证和审计动作。',
      path: path.join(projectConfigDir, 'hooks', 'hooks.json'),
      kind: 'file',
    }),
    buildItem({
      id: 'project-settings',
      label: '项目 settings',
      description: '项目级文件化设置；hooks 应放到 hooks/hooks.json。',
      path: projectSettingsPath,
      kind: 'file',
      active: !projectSettingsWarning,
      warning: projectSettingsWarning,
    }),
    buildItem({
      id: 'project-mcp',
      label: '项目 MCP',
      description: '团队共享的 MCP server 模板。',
      path: mcpPaths.project ?? path.join(projectConfigDir, 'mcp.json'),
      kind: 'file',
    }),
    buildItem({
      id: 'project-skills',
      label: '项目 skills',
      description: '随项目走的技能模板。',
      path: skillsDirs.project?.new ?? path.join(projectConfigDir, 'skills'),
      kind: 'directory',
    }),
    buildItem({
      id: 'project-agents',
      label: '项目 agents',
      description: '随项目走的自定义 agent 定义。',
      path: agentDirs.project ?? path.join(projectConfigDir, 'agents'),
      kind: 'directory',
    }),
    buildItem({
      id: 'project-rules',
      label: '项目 rules',
      description: '随项目走的路径规则。',
      path: rulesDirs.project ?? path.join(projectConfigDir, 'rules'),
      kind: 'directory',
    }),
    buildItem({
      id: 'project-agents-md',
      label: 'AGENTS.md',
      description: '工作区 instruction discovery 文件。',
      path: path.join(workingDirectory, 'AGENTS.md'),
      kind: 'file',
    }),
    buildItem({
      id: 'project-claude-md',
      label: 'CLAUDE.md',
      description: 'Claude 兼容 instruction discovery 文件。',
      path: path.join(workingDirectory, 'CLAUDE.md'),
      kind: 'file',
    }),
  ]) : [];

  const localItems = workingDirectory && projectConfigDir ? await Promise.all([
    buildItem({
      id: 'local-mcp',
      label: 'MCP local override',
      description: '同一项目里个人机器上的 token、端口和私有 endpoint。',
      path: mcpPaths.local ?? path.join(projectConfigDir, 'mcp.local.json'),
      kind: 'file',
      private: true,
    }),
    buildItem({
      id: 'local-claude-settings',
      label: 'Claude local settings',
      description: 'Claude 兼容本地设置；Agent Neo 只继承部分 legacy 链路。',
      path: path.join(workingDirectory, '.claude', 'settings.local.json'),
      kind: 'file',
      private: true,
      active: false,
      detail: '兼容线索，不是通用 local 层',
    }),
  ]) : [];

  const runtimeItems = await Promise.all([
    buildItem({
      id: 'runtime-app-settings',
      label: '应用 settings',
      description: 'Settings UI 正在读写的主配置文件。',
      path: path.join(userDataDir, 'config.json'),
      kind: 'file',
      private: true,
    }),
    buildItem({
      id: 'runtime-db',
      label: '应用数据库',
      description: '会话、消息、记忆和工具记录的本地数据库。',
      path: path.join(userDataDir, 'code-agent.db'),
      kind: 'file',
      private: true,
    }),
    buildItem({
      id: 'runtime-browser-profile',
      label: '浏览器 profile',
      description: 'Managed browser 登录态、cookies、历史和缓存。',
      path: path.join(userDataDir, 'managed-browser-profile'),
      kind: 'directory',
      private: true,
    }),
    buildItem({
      id: 'runtime-builtins',
      label: '内置默认',
      description: '无文件命中时使用的产品默认 prompt、hooks 事件和能力定义。',
      path: 'app bundle',
      kind: 'runtime',
      active: true,
    }),
  ]);

  return {
    workingDirectory,
    generatedAt: Date.now(),
    layers: [
      buildLayer('user', 'User', '跨项目、当前 OS 用户私有的配置和能力。', userConfigDir, userItems),
      buildLayer('project', 'Project', '跟随当前工作区，可审计后进入仓库的团队配置。', projectConfigDir ?? '未设置工作区', projectItems),
      buildLayer('local', 'Local', '当前项目里的个人覆盖和私有端点，应该留在 gitignore。', projectConfigDir ?? '未设置工作区', localItems),
      buildLayer('runtime', 'Runtime', 'Settings UI、数据库、浏览器 profile 和内置 fallback。', userDataDir, runtimeItems),
    ],
    writeRecommendations: CONFIG_WRITE_RECOMMENDATIONS,
    safetyScan,
  };
}

export async function handleGetConfigScope(
  payload: { workingDirectory?: string | null } | undefined,
  getAppService: () => AgentApplicationService | null,
): Promise<ConfigScopeSummary> {
  const workingDirectory = payload?.workingDirectory?.trim()
    || getAppService()?.getWorkingDirectory()
    || null;
  return buildConfigScopeSummary(workingDirectory);
}
