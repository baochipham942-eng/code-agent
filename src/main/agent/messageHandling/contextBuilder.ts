// ============================================================================
// Context Builder - Build enhanced system prompts with RAG
// ============================================================================

import * as os from 'os';
import { execSync } from 'child_process';
import { createLogger } from '../../services/infra/logger';
import { getAppName, getAppVersion, isPackaged } from '../../platform/appPaths';

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
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe', timeout: 3000 });
    gitRepoCache.set(dir, true);
    return true;
  } catch {
    gitRepoCache.set(dir, false);
    return false;
  }
}

/**
 * Build environment info block (Claude Code style <env> block)
 * Injected once per prompt assembly — ~60 tokens, zero tool calls saved.
 */
function buildEnvironmentBlock(workingDirectory: string): string {
  const platform = process.platform;                    // darwin / linux / win32
  const osVersion = `${os.type()} ${os.release()}`;    // Darwin 25.2.0
  const shell = process.env.SHELL || process.env.COMSPEC || 'unknown';
  const today = new Date().toISOString().split('T')[0]; // 2026-02-13
  const gitRepo = isGitRepo(workingDirectory);

  return `<env>
Working directory: ${workingDirectory}
Is directory a git repo: ${gitRepo ? 'Yes' : 'No'}
Platform: ${platform}
OS Version: ${osVersion}
Default Shell: ${shell}
Home Directory: ${os.homedir()}
Today's date: ${today}
</env>`;
}

/**
 * Build runtime mode block — tells the model whether it's running in GUI or CLI,
 * and provides self-awareness about the app itself (name, version, source location).
 * This prevents the model from:
 * 1. Thinking in CLI terms when inside a desktop app
 * 2. Not knowing it IS code-agent when asked to fix its own bugs
 */
export function buildRuntimeModeBlock(): string {
  const isCLI = process.env.CODE_AGENT_CLI_MODE === 'true';

  // Self-awareness: app identity and source code location
  let appIdentity = '';
  try {
    const appName = getAppName() || 'Code Agent';
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

  if (isCLI) {
    return `\n\n<runtime_mode>
You are running in CLI mode (terminal). The user interacts via command line.
GUI features (screenshot, browser_action) are unavailable.${appIdentity}
</runtime_mode>`;
  }

  return `\n\n<runtime_mode>
You are running inside a desktop GUI application.
Users interact through a visual chat interface, not a terminal.
When explaining solutions, frame them from the user's perspective — describe what you're doing, not internal tool names.${appIdentity}
</runtime_mode>`;
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

**When user intent is UNCLEAR about location**, use \`ask_user_question\`:
\`\`\`json
{
  "question": "你想把文件保存在哪里？",
  "options": [
    { "label": "桌面", "description": "~/Desktop" },
    { "label": "下载文件夹", "description": "~/Downloads" },
    { "label": "默认工作区", "description": "${workingDirectory}" }
  ]
}
\`\`\`

**When user intent is CLEAR**, just use the appropriate path directly.`
    : `Use relative paths (resolved against working directory) or absolute paths.`;

  return `${basePrompt}\n\n${envBlock}\n\n${workingDirInfo}`;
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
