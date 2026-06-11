// ============================================================================
// Context Builder - Build enhanced system prompts with RAG
// ============================================================================

import * as os from 'os';
import { execSync } from 'child_process';
import { createLogger } from '../../services/infra/logger';
import { getAppName, getAppVersion, isPackaged } from '../../platform/appPaths';
import { getEnvCapabilities } from '../../services/core/envCapabilities';

const logger = createLogger('ContextBuilder');


// ----------------------------------------------------------------------------
// Working Directory Context
// ----------------------------------------------------------------------------

// Cache git repo detection per directory (avoids repeated execSync calls)
const gitRepoCache = new Map<string, boolean>();

function isGitRepo(dir: string): boolean {
  const cached = gitRepoCache.get(dir);
  if (cached !== undefined) return cached;
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe', timeout: GIT_CMD_TIMEOUT_MS });
    gitRepoCache.set(dir, true);
    return true;
  } catch {
    gitRepoCache.set(dir, false);
    return false;
  }
}

// ----------------------------------------------------------------------------
// Git Context (GAP-010)
// 课程 H3 五项优化之一："Git 上下文自动加载——注入分支名/commit/diff"
// 约 100-200 token 换 agent 对仓库状态的基础感知（cowork 场景下用户说
// "继续昨天的活"时尤其有用）。分支/commit/dirty 状态是易变信息，用 TTL
// 缓存而非永久缓存，避免每轮 prompt assembly 跑 3 次 execSync。
// ----------------------------------------------------------------------------

const GIT_CMD_TIMEOUT_MS = 3000;
const GIT_CONTEXT_TTL_MS = 30_000;
const GIT_RECENT_COMMITS_COUNT = 5;

interface GitContextInfo {
  isRepo: boolean;
  branch?: string;
  recentCommits?: string[];
  dirtyFileCount?: number;
}

const gitContextCache = new Map<string, { info: GitContextInfo; fetchedAt: number }>();

function runGit(dir: string, args: string): string | null {
  try {
    return execSync(`git ${args}`, { cwd: dir, stdio: 'pipe', timeout: GIT_CMD_TIMEOUT_MS })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function getGitContext(dir: string): GitContextInfo {
  const cached = gitContextCache.get(dir);
  if (cached && Date.now() - cached.fetchedAt < GIT_CONTEXT_TTL_MS) return cached.info;

  if (!isGitRepo(dir)) {
    const info: GitContextInfo = { isRepo: false };
    gitContextCache.set(dir, { info, fetchedAt: Date.now() });
    return info;
  }

  const branch = runGit(dir, 'branch --show-current') || undefined;
  const log = runGit(dir, `log --oneline -${GIT_RECENT_COMMITS_COUNT}`);
  const recentCommits = log ? log.split('\n').filter(Boolean) : undefined;
  const status = runGit(dir, 'status --porcelain');
  const dirtyFileCount = status === null
    ? undefined
    : status
      ? status.split('\n').filter(Boolean).length
      : 0;

  const info: GitContextInfo = { isRepo: true, branch, recentCommits, dirtyFileCount };
  gitContextCache.set(dir, { info, fetchedAt: Date.now() });
  return info;
}

/** 测试用：清空 git 上下文缓存 */
export function resetGitContextCache(): void {
  gitRepoCache.clear();
  gitContextCache.clear();
}

/** 把 git 上下文渲染成 env block 里的多行文本 */
function renderGitContext(git: GitContextInfo): string {
  if (!git.isRepo) return 'Is directory a git repo: No';

  const lines = ['Is directory a git repo: Yes'];
  lines.push(`Current branch: ${git.branch || '(detached HEAD)'}`);
  if (git.dirtyFileCount !== undefined) {
    lines.push(
      git.dirtyFileCount > 0
        ? `Working tree: dirty (${git.dirtyFileCount} file(s) changed)`
        : 'Working tree: clean',
    );
  }
  if (git.recentCommits && git.recentCommits.length > 0) {
    lines.push('Recent commits:');
    for (const commit of git.recentCommits) {
      lines.push(`  ${commit}`);
    }
  }
  return lines.join('\n');
}

/**
 * Build environment info block (Claude Code style <env> block)
 * Injected once per prompt assembly — ~100-250 tokens, zero tool calls saved.
 *
 * Git 仓库时额外注入分支 / working tree dirty 状态 / 最近 commit（GAP-010），
 * 让模型不用跑 git status/log 就有仓库状态的基础感知。
 *
 * 如果启动时探针已跑完（getEnvCapabilities 返回非 null），还会追加一个
 * <env-capabilities> 块列出本地可用的 CLI，并提示模型用 Bash + `--help` 探索。
 * 不点名具体场景，给清单 + discovery 原则即可。
 */
function buildEnvironmentBlock(workingDirectory: string): string {
  const platform = process.platform;                    // darwin / linux / win32
  const osVersion = `${os.type()} ${os.release()}`;    // Darwin 25.2.0
  const shell = process.env.SHELL || process.env.COMSPEC || 'unknown';
  const today = new Date().toISOString().split('T')[0]; // 2026-02-13
  const gitContext = getGitContext(workingDirectory);

  const baseBlock = `<env>
Working directory: ${workingDirectory}
${renderGitContext(gitContext)}
Platform: ${platform}
OS Version: ${osVersion}
Default Shell: ${shell}
Home Directory: ${os.homedir()}
Today's date: ${today}
</env>`;

  const caps = getEnvCapabilities();
  if (!caps || caps.length === 0) return baseBlock;

  const cliList = caps.map((c) => c.name).join(', ');
  const capsBlock = `<env-capabilities>
Local CLIs detected on PATH: ${cliList}
When built-in tools (WebFetch / Glob / Grep / Read / Edit / Write) don't fit your need — e.g. anti-scraping pages, niche file formats, structured data wrangling — invoke any of these via Bash. Probe unfamiliar CLIs with \`<cli> --help\` before using.
</env-capabilities>`;

  return `${baseBlock}\n\n${capsBlock}`;
}

/**
 * Build runtime mode block — tells the model whether it's running in GUI or CLI,
 * and provides self-awareness about the app itself (name, version, source location).
 * This prevents the model from:
 * 1. Thinking in CLI terms when inside a desktop app
 * 2. Not knowing it IS Agent Neo when asked to fix its own bugs
 */
export function buildRuntimeModeBlock(): string {
  const isCLIOnly = process.env.CODE_AGENT_CLI_MODE === 'true'
    && process.env.CODE_AGENT_WEB_MODE !== 'true';
  const isWebMode = process.env.CODE_AGENT_WEB_MODE === 'true';

  // Self-awareness: app identity and source code location
  let appIdentity = '';
  try {
    const appName = getAppName() || 'Agent Neo';
    const appVersion = getAppVersion() || 'unknown';
    const packed = isPackaged();
    // In dev mode: source = process.cwd(); packaged: source = app.getAppPath()
    const sourcePath = packed ? '' : process.cwd();
    appIdentity = `\nYou ARE the "${appName}" application (v${appVersion}).`;
    if (sourcePath) {
      appIdentity += `\nYour own source code is at: ${sourcePath}`;
      appIdentity += `\nIf the user asks you to fix your own bugs, navigate to that path — not the sandbox working directory.`;
    }
  } catch {
    // electron not available (test env)
  }

  if (isCLIOnly) {
    return `\n\n<runtime_mode>
You are running in CLI mode (terminal). The user interacts via command line.
GUI features (screenshot, browser_action) are unavailable.${appIdentity}
</runtime_mode>`;
  }

  // Computer-use 操作协议：仅当 cua-driver 启用时注入，避免污染普通会话的上下文预算。
  // 实现 docs/proposals/computer-use-cua-migration.md §3（任务分流）+ §11（快照不变量/错误自纠）。
  const cuaBlock = buildComputerUseBlock();

  if (isWebMode) {
    return `\n\n<runtime_mode>
You are running in the Agent Neo app-host web runtime.
Users interact through a visual chat interface, not a terminal.
CODE_AGENT_CLI_MODE may be true here for Node/native-module compatibility; do not infer from it that browser, screenshot, or Computer Use tools are unavailable.
Browser and Computer Use capabilities depend on loaded tool definitions and runtime readiness.${appIdentity}
</runtime_mode>${cuaBlock}`;
  }

  return `\n\n<runtime_mode>
You are running inside a desktop GUI application.
Users interact through a visual chat interface, not a terminal.
When explaining solutions, frame them from the user's perspective — describe what you're doing, not internal tool names.${appIdentity}
</runtime_mode>${cuaBlock}`;
}

/**
 * cua-driver computer-use 操作协议块。
 * 仅当 CODE_AGENT_ENABLE_CUA=1 时返回内容，否则空串（零上下文开销）。
 * 内容对齐 docs/proposals/computer-use-cua-migration.md §3 / §11。
 */
export function buildComputerUseBlock(): string {
  if (process.env.CODE_AGENT_ENABLE_CUA !== '1') return '';
  return `\n\n<computer_use_protocol>
You can drive native desktop apps via cua-driver tools (mcp__cua-driver__*). Follow this protocol exactly:
- Use cua-driver tools ONLY for desktop GUI control. Do NOT use legacy computer_use / Computer / gui_agent tools — they are disabled in this mode and conflict with cua-driver.
- Snapshot before AND after every action: call get_window_state({pid, window_id, capture_mode:"ax"}) to get fresh [element_index N], act by element_index, then re-snapshot to verify the change. An element_index is invalidated by the next snapshot — never reuse one across snapshots.
- VERIFY VIA AX, NOT SCREENSHOTS: to confirm a result (e.g. the calculator shows "12"), re-call get_window_state and read the AX tree_markdown text (AXStaticText values, etc.). Do NOT use the screenshot tool or image/vision analysis to verify — it is slower, can steal foreground, and may hit vision-model errors.
- VERIFY VIA AN INDEPENDENT SIGNAL: after set_value/type_text, do NOT treat re-reading the SAME element's AXValue as proof — AX setValue can update the attribute without firing the app's change handlers (same-channel write+read false-passes). Confirm through a signal that depends on the input taking real effect: a downstream element changed (result text, validation state, a button becoming enabled), or the next step succeeding. If no independent signal exists, prefer type_text (real keystrokes) over set_value and say you could not fully verify.
- Prefer AX/element_index over pixel coordinates. Keep capture_mode:"ax" (AX tree only, no screenshot, no Screen Recording needed); only use "som"/"vision" if AX genuinely lacks the info AND Screen Recording is granted.
- Background, no focus steal: launch_app runs apps in the background. Do NOT activate / foreground / bring_to_front an app unless the user explicitly asked — operate on the background window via element_index.
- Web pages / browser tasks: use the browser_action tool (Playwright), NOT cua-driver — cua's background DOM clicks degrade on Chromium-based windows.
- On error, the tool returns an actionable hint (e.g. stale index → re-snapshot; AXPress failed → try a menu/confirm equivalent). Follow it. If the post-action snapshot shows no change, treat it as a silent failure and retry rather than assuming success.
</computer_use_protocol>`;
}

/**
 * Inject working directory context + environment info into system prompt
 */
export function injectWorkingDirectoryContext(
  basePrompt: string,
  workingDirectory: string,
  isDefaultWorkingDirectory: boolean
): string {
  // Environment block (platform, OS, shell, date, git)
  const envBlock = buildEnvironmentBlock(workingDirectory);

  const workingDirInfo = isDefaultWorkingDirectory
    ? `**File Path Rules**:
- **Relative paths** (e.g., \`game/index.html\`) → resolved against working directory
- **Absolute paths** (e.g., \`/Users/xxx/project/file.txt\`) → used directly
- **Home paths** (e.g., \`~/Desktop/file.txt\`) → expanded to user's home directory

**When user intent is UNCLEAR about location**, use \`AskUserQuestion\`:
\`\`\`json
{
  "questions": [
    {
      "header": "保存位置",
      "question": "你想把文件保存在哪里？",
      "options": [
        { "label": "桌面", "description": "~/Desktop" },
        { "label": "下载文件夹", "description": "~/Downloads" },
        { "label": "默认工作区", "description": "${workingDirectory}" }
      ]
    }
  ]
}
\`\`\`

**When user intent is CLEAR**, just use the appropriate path directly.`
    : `Use relative paths (resolved against working directory) or absolute paths.`;

  const workingDirBoundaryInfo = `**Working Directory Boundary**:
- Treat the working directory as the default base for relative file paths, not as the full boundary of the user's task.
- If the user asks about this Mac, local disk, caches, downloads, apps, processes, or other machine-level state, inspect the relevant absolute paths under the home directory instead of asking for a project path just because the working directory is empty or unrelated.
- If the previous assistant turn promised to continue work (for example ended after a colon or "let me check") and the user says "继续", "看呀", or a similar short confirmation, continue from the already established task scope and latest tool results.
- Do not quote or paraphrase a phrase as the user's wording unless the user actually wrote it.`;

  return `${basePrompt}\n\n${envBlock}\n\n${workingDirInfo}\n\n${workingDirBoundaryInfo}`;
}

// ----------------------------------------------------------------------------
// RAG Context Building
// ----------------------------------------------------------------------------

export interface RAGContextOptions {
  includeCode?: boolean;
  includeKnowledge?: boolean;
  includeConversations?: boolean;
  maxTokens?: number;
}

/**
 * Build enhanced system prompt with RAG context
 *
 * Legacy RAG / hybrid search / proactive context / core memory modules removed.
 * Returns basePrompt unchanged — Light Memory handles context injection separately.
 */
export async function buildEnhancedSystemPrompt(
  basePrompt: string,
  _userQuery: string,
  _isSimpleTaskMode: boolean
): Promise<string> {
  return basePrompt;
}
