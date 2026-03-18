// ============================================================================
// Context Builder - Build enhanced system prompts with RAG
// ============================================================================

import * as os from 'os';
import { execSync } from 'child_process';
import { getMemoryService } from '../../memory/memoryService';
import { getCoreMemoryService } from '../../memory/coreMemory';
import { getProactiveContextService } from '../../memory/proactiveContext';
import { getDatabase } from '../../services/core/databaseService';
import { getHybridSearchService } from '../../memory/hybridSearch';
import { getLocalVectorStore } from '../../memory/localVectorStore';
import { createLogger } from '../../services/infra/logger';
import { MEMORY } from '../../../shared/constants';
import { logCollector } from '../../mcp/logCollector';
import { RAGContextCache } from '../../context/tokenOptimizer';

const logger = createLogger('ContextBuilder');

// Session-level RAG cache to avoid redundant queries
const ragCache = new RAGContextCache({ ttl: 5 * 60 * 1000, maxEntries: 10 });


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
    const { getAppName, getAppVersion, isPackaged } = require('../../platform/appPaths');
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
You are running inside a desktop GUI application (Electron).
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
 * Build enhanced system prompt with RAG context (sync version)
 *
 * Gen3-4: Lightweight RAG (project knowledge and user preferences only)
 * Gen5+: Full RAG (code, knowledge base, supports cloud search + proactive context)
 */
export async function buildEnhancedSystemPrompt(
  basePrompt: string,
  userQuery: string,
  isSimpleTaskMode: boolean
): Promise<string> {
  // Skip RAG for simple tasks
  if (isSimpleTaskMode) {
    logger.debug('Skipping RAG for simple task (fast path)');
    return basePrompt;
  }

  if (!userQuery) {
    return basePrompt;
  }

  try {
    const memoryService = getMemoryService();
    let enhancedPrompt = basePrompt;

    // Full RAG: code, knowledge, and cloud search
    {
      // Gen5+: Full RAG with code, knowledge, and cloud search
      // Check cache first to avoid redundant queries
      let ragContext: string | undefined;
      const cached = ragCache.get(userQuery);

      if (cached) {
        ragContext = cached.context;
        logger.debug(`RAG cache hit: ${cached.tokens} tokens saved`);
      } else {
        // Try hybrid search first, fall back to legacy RAG
        let hybridSearchFailed = false;
        try {
          const vectorStore = getLocalVectorStore();
          const hybridSearch = getHybridSearchService(vectorStore);
          const { results } = await hybridSearch.search(userQuery, {
            topK: 10,
            threshold: 0.3,
          });

          if (results.length > 0) {
            ragContext = results
              .map(r => `[${r.metadata?.type || 'unknown'}] ${r.content}`)
              .join('\n\n');
            logger.debug(`Hybrid search returned ${results.length} results`);
          } else {
            hybridSearchFailed = true;
            logger.debug('Hybrid search returned 0 results, falling back to legacy RAG');
          }
        } catch (hybridError) {
          hybridSearchFailed = true;
          logger.warn('Hybrid search failed, falling back to legacy RAG:', hybridError);
        }

        // Fallback to legacy RAG when hybrid search fails or returns empty
        if (hybridSearchFailed) {
          ragContext = memoryService.getRAGContext(userQuery, {
            includeCode: true,
            includeKnowledge: true,
            includeConversations: false,
            maxTokens: 1500,
          });
        }

        // Cache the result for future queries
        if (ragContext && ragContext.trim().length > 0) {
          ragCache.set(userQuery, ragContext);
        }
      }

      if (ragContext && ragContext.trim().length > 0) {
        enhancedPrompt += `\n\n## Relevant Context from Memory\n\nThe following context was retrieved from your knowledge base and may be helpful:\n\n${ragContext}`;
      }
    }

    // Entity relationship context
    {
      try {
        const proactive = getProactiveContextService();
        const entities = proactive.detectEntities(userQuery);

        if (entities.length > 0) {
          const db = getDatabase();
          const relationLines: string[] = [];

          for (const entity of entities.slice(0, 5)) {
            const relations = db.getRelationsFor(entity.value, 'both', {
              decayDays: MEMORY.RELATION_DECAY_DAYS,
              minConfidence: MEMORY.RELATION_CONTEXT_MIN_CONFIDENCE,
            });
            if (relations.length > 0) {
              const relStr = relations
                .slice(0, 3)
                .map(r => `  ${r.sourceId} --[${r.relationType}]--> ${r.targetId}`)
                .join('\n');
              relationLines.push(`**${entity.type}:${entity.value}**:\n${relStr}`);
            }
          }

          if (relationLines.length > 0) {
            enhancedPrompt += `\n\n## Entity Relationships\n\n${relationLines.join('\n\n')}`;
          }
        }
      } catch {
        // Entity relationship context is optional, never block prompt assembly
      }
    }

    // Add project knowledge (all Gen3+)
    const projectKnowledge = memoryService.getProjectKnowledge();
    if (projectKnowledge.length > 0) {
      const knowledgeStr = projectKnowledge
        .slice(0, 5)
        .map((k) => `- **${k.key}**: ${typeof k.value === 'string' ? k.value : JSON.stringify(k.value)}`)
        .join('\n');
      enhancedPrompt += `\n\n## Project Knowledge\n\n${knowledgeStr}`;
    }

    // Add user preferences from Core Memory (all Gen3+)
    try {
      const coreMemory = getCoreMemoryService();
      const preferencesPrompt = coreMemory.formatForSystemPrompt();
      if (preferencesPrompt) {
        enhancedPrompt += `\n\n${preferencesPrompt}`;
      }
    } catch {
      // Fallback to legacy KV-based preferences if CoreMemory fails
      const codingStyle = memoryService.getUserPreference<Record<string, unknown>>('coding_style');
      if (codingStyle && Object.keys(codingStyle).length > 0) {
        const styleStr = Object.entries(codingStyle)
          .map(([key, value]) => `- ${key}: ${value}`)
          .join('\n');
        enhancedPrompt += `\n\n## User Coding Preferences\n\n${styleStr}`;
      }
    }

    logger.debug('Enhanced system prompt with full RAG');
    return enhancedPrompt;
  } catch (error) {
    logger.error('Failed to build enhanced system prompt:', error);
    return basePrompt;
  }
}

