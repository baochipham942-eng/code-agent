// ============================================================================
// Context Builder - Build enhanced system prompts with RAG
// ============================================================================

import { getMemoryService } from '../../memory/memoryService';
import { getCoreMemoryService } from '../../memory/coreMemory';
import { getProactiveContextService } from '../../memory/proactiveContext';
import { createLogger } from '../../services/infra/logger';
import { logCollector } from '../../mcp/logCollector';
import { RAGContextCache } from '../../context/tokenOptimizer';

const logger = createLogger('ContextBuilder');

// Session-level RAG cache to avoid redundant queries
const ragCache = new RAGContextCache({ ttl: 5 * 60 * 1000, maxEntries: 10 });

// ----------------------------------------------------------------------------
// Working Directory Context
// ----------------------------------------------------------------------------

/**
 * Inject working directory context into system prompt
 */
export function injectWorkingDirectoryContext(
  basePrompt: string,
  workingDirectory: string,
  isDefaultWorkingDirectory: boolean
): string {
  const workingDirInfo = isDefaultWorkingDirectory
    ? `## Working Directory

**Default working directory**: \`${workingDirectory}\`

**File Path Rules**:
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
    : `## Working Directory

**Current working directory**: \`${workingDirectory}\`

Use relative paths (resolved against this directory) or absolute paths.`;

  return `${basePrompt}\n\n${workingDirInfo}`;
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
export function buildEnhancedSystemPrompt(
  basePrompt: string,
  userQuery: string,
  generationId: string,
  isSimpleTaskMode: boolean
): string {
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

    // Determine RAG level based on generation
    const genNum = parseInt(generationId.replace('gen', ''), 10);
    const isFullRAG = genNum >= 5;
    const isLightRAG = genNum >= 3 && genNum < 5;

    if (isFullRAG) {
      // Gen5+: Full RAG with code, knowledge, and cloud search
      // Check cache first to avoid redundant queries
      let ragContext: string | undefined;
      const cached = ragCache.get(userQuery);

      if (cached) {
        ragContext = cached.context;
        logger.debug(`RAG cache hit: ${cached.tokens} tokens saved`);
      } else {
        ragContext = memoryService.getRAGContext(userQuery, {
          includeCode: true,
          includeKnowledge: true,
          includeConversations: false,
          maxTokens: 1500,
        });

        // Cache the result for future queries
        if (ragContext && ragContext.trim().length > 0) {
          ragCache.set(userQuery, ragContext);
        }
      }

      if (ragContext && ragContext.trim().length > 0) {
        enhancedPrompt += `\n\n## Relevant Context from Memory\n\nThe following context was retrieved from your knowledge base and may be helpful:\n\n${ragContext}`;
      }
    } else if (isLightRAG) {
      // Gen3-4: Lightweight RAG - only project knowledge, no code/conversation search
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

    const ragType = isFullRAG ? 'full' : isLightRAG ? 'light' : 'none';
    logger.debug(`Enhanced system prompt with ${ragType} RAG for ${generationId}`);
    return enhancedPrompt;
  } catch (error) {
    logger.error('Failed to build enhanced system prompt:', error);
    return basePrompt;
  }
}

/**
 * Build enhanced system prompt with proactive context (async version)
 * Detects entities in user message and auto-fetches relevant context
 * Used for Gen5+ to provide intelligent context injection
 */
export async function buildEnhancedSystemPromptWithProactiveContext(
  basePrompt: string,
  userQuery: string,
  generationId: string,
  isSimpleTaskMode: boolean,
  workingDirectory?: string
): Promise<{ prompt: string; proactiveSummary: string }> {
  try {
    // First build the standard enhanced prompt
    let enhancedPrompt = buildEnhancedSystemPrompt(basePrompt, userQuery, generationId, isSimpleTaskMode);

    if (!userQuery) {
      return { prompt: enhancedPrompt, proactiveSummary: '' };
    }

    // Determine if we should use proactive context
    const genNum = parseInt(generationId.replace('gen', ''), 10);
    if (genNum < 5) {
      return { prompt: enhancedPrompt, proactiveSummary: '' };
    }

    // Use ProactiveContextService to detect entities and fetch context
    const proactiveService = getProactiveContextService();
    const proactiveResult = await proactiveService.analyzeAndFetchContext(
      userQuery,
      workingDirectory
    );

    // If we found relevant context, format and add it
    if (proactiveResult.context.length > 0) {
      const formattedContext = proactiveService.formatContextForPrompt(proactiveResult);
      enhancedPrompt += `\n\n${formattedContext}`;

      logger.info(
        `Proactive context injected: ${proactiveResult.totalItems} items ` +
        `(${proactiveResult.cloudItems} from cloud), entities: ${proactiveResult.entities.map(e => e.type).join(', ')}`
      );

      logCollector.agent('INFO', 'Proactive context injected', {
        totalItems: proactiveResult.totalItems,
        cloudItems: proactiveResult.cloudItems,
        entities: proactiveResult.entities.map(e => ({ type: e.type, value: e.value })),
      });
    }

    return {
      prompt: enhancedPrompt,
      proactiveSummary: proactiveResult.summary,
    };
  } catch (error) {
    logger.error('Failed to build proactive context:', error);
    return {
      prompt: buildEnhancedSystemPrompt(basePrompt, userQuery, generationId, isSimpleTaskMode),
      proactiveSummary: ''
    };
  }
}

/**
 * Build enhanced system prompt with cloud RAG context (async version)
 * Used when cloud search is enabled for Gen5+
 */
export async function buildEnhancedSystemPromptAsync(
  basePrompt: string,
  userQuery: string,
  generationId: string,
  isSimpleTaskMode: boolean
): Promise<{
  prompt: string;
  cloudSources: Array<{ type: string; path?: string; score: number; fromCloud: boolean }>;
}> {
  try {
    if (!userQuery) {
      return { prompt: basePrompt, cloudSources: [] };
    }

    // Determine if we should use cloud search
    const genNum = parseInt(generationId.replace('gen', ''), 10);
    const shouldUseCloud = genNum >= 5;

    if (!shouldUseCloud) {
      return {
        prompt: buildEnhancedSystemPrompt(basePrompt, userQuery, generationId, isSimpleTaskMode),
        cloudSources: []
      };
    }

    // Gen5+: Use cloud-enhanced system prompt builder
    const memoryService = getMemoryService();
    const result = await memoryService.buildEnhancedSystemPromptWithCloud(
      basePrompt,
      userQuery,
      {
        includeCloud: true,
        crossProject: false,
        maxTokens: 2000,
      }
    );

    logger.debug(`Cloud-enhanced system prompt, ${result.sources.length} sources`);
    return {
      prompt: result.prompt,
      cloudSources: result.sources,
    };
  } catch (error) {
    logger.error('Failed to build cloud-enhanced system prompt:', error);
    return {
      prompt: buildEnhancedSystemPrompt(basePrompt, userQuery, generationId, isSimpleTaskMode),
      cloudSources: []
    };
  }
}
