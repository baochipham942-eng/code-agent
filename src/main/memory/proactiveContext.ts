// ============================================================================
// Proactive Context Service - Automatically inject relevant context
// Enhancement 4: Proactive RAG Context Injection
// ============================================================================

import { getMemoryService } from './memoryService';
import { getVectorStore } from './vectorStore';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ProactiveContext');

// Entity types that can be detected in user messages
export type EntityType =
  | 'file'
  | 'function'
  | 'class'
  | 'variable'
  | 'concept'
  | 'error'
  | 'package'
  | 'pattern';

// Detected entity with metadata
export interface DetectedEntity {
  type: EntityType;
  value: string;
  confidence: number;
  context?: string;
}

// Context item with relevance scoring
export interface ContextItem {
  content: string;
  type: 'code' | 'knowledge' | 'pattern' | 'history';
  source: string;
  relevance: number;
  isCloud: boolean;
  entity?: string;
}

// Proactive context result
export interface ProactiveContextResult {
  entities: DetectedEntity[];
  context: ContextItem[];
  summary: string;
  totalItems: number;
  cloudItems: number;
}

// Configuration options
export interface ProactiveContextConfig {
  minRelevance: number;        // Minimum relevance threshold (0-1)
  maxContextItems: number;     // Maximum context items to return
  maxContextLength: number;    // Maximum total context length
  enableCloudSearch: boolean;  // Search cloud for context
  detectPatterns: boolean;     // Detect and match patterns
  detectErrors: boolean;       // Detect error mentions
}

const DEFAULT_CONFIG: ProactiveContextConfig = {
  minRelevance: 0.65,
  maxContextItems: 10,
  maxContextLength: 8000,
  enableCloudSearch: true,
  detectPatterns: true,
  detectErrors: true,
};

// Regular expressions for entity detection
const ENTITY_PATTERNS = {
  // File paths and names
  file: /(?:^|[\s'"(])([a-zA-Z_][\w-]*(?:\/[\w.-]+)*\.[a-zA-Z]{1,10})(?:[\s'")\]:]|$)/g,

  // Function/method names (camelCase, snake_case, PascalCase)
  function: /(?:function|def|fn|async\s+function|const|let|var)\s+([a-zA-Z_][\w]*)\s*[(<:=]/g,

  // Class names (PascalCase)
  class: /(?:class|interface|type|struct|enum)\s+([A-Z][\w]*)/g,

  // Error patterns
  error: /(?:error|exception|failed|failure|TypeError|ReferenceError|SyntaxError)[:\s]+([^\n.]+)/gi,

  // Package/module names
  package: /(?:import|require|from)\s+['"]([^'"]+)['"]/g,

  // Common programming concepts
  concept: /\b(authentication|authorization|caching|database|api|routing|state management|testing|deployment|performance|security|memory|concurrency|async|promise|stream)\b/gi,
};

// Singleton instance
let proactiveContextService: ProactiveContextService | null = null;

/**
 * ProactiveContextService - Automatically detects entities and fetches relevant context
 */
export class ProactiveContextService {
  private config: ProactiveContextConfig;
  private recentEntities: Map<string, number> = new Map(); // entity -> timestamp

  constructor(config: Partial<ProactiveContextConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Analyze user message and proactively fetch relevant context
   */
  async analyzeAndFetchContext(
    userMessage: string,
    workingDirectory?: string
  ): Promise<ProactiveContextResult> {
    // Step 1: Detect entities in the message
    const entities = this.detectEntities(userMessage);

    // Step 2: Track recent entities for better context
    this.trackEntities(entities);

    // Step 3: Fetch context for detected entities
    const contextItems = await this.fetchContextForEntities(
      entities,
      userMessage,
      workingDirectory
    );

    // Step 4: Score and filter context by relevance
    const filteredContext = this.filterByRelevance(contextItems);

    // Step 5: Truncate to fit within limits
    const truncatedContext = this.truncateContext(filteredContext);

    // Step 6: Generate summary
    const summary = this.generateContextSummary(entities, truncatedContext);

    return {
      entities,
      context: truncatedContext,
      summary,
      totalItems: truncatedContext.length,
      cloudItems: truncatedContext.filter(c => c.isCloud).length,
    };
  }

  /**
   * Detect entities in user message
   */
  detectEntities(message: string): DetectedEntity[] {
    const entities: DetectedEntity[] = [];
    const seen = new Set<string>();

    // Detect files
    let match;
    const fileRegex = new RegExp(ENTITY_PATTERNS.file.source, 'g');
    while ((match = fileRegex.exec(message)) !== null) {
      const value = match[1];
      if (!seen.has(`file:${value}`)) {
        seen.add(`file:${value}`);
        entities.push({
          type: 'file',
          value,
          confidence: 0.9,
          context: this.extractContext(message, match.index),
        });
      }
    }

    // Detect functions
    const funcRegex = new RegExp(ENTITY_PATTERNS.function.source, 'g');
    while ((match = funcRegex.exec(message)) !== null) {
      const value = match[1];
      if (!seen.has(`function:${value}`)) {
        seen.add(`function:${value}`);
        entities.push({
          type: 'function',
          value,
          confidence: 0.85,
          context: this.extractContext(message, match.index),
        });
      }
    }

    // Detect classes
    const classRegex = new RegExp(ENTITY_PATTERNS.class.source, 'g');
    while ((match = classRegex.exec(message)) !== null) {
      const value = match[1];
      if (!seen.has(`class:${value}`)) {
        seen.add(`class:${value}`);
        entities.push({
          type: 'class',
          value,
          confidence: 0.85,
          context: this.extractContext(message, match.index),
        });
      }
    }

    // Detect errors (if enabled)
    if (this.config.detectErrors) {
      const errorRegex = new RegExp(ENTITY_PATTERNS.error.source, 'gi');
      while ((match = errorRegex.exec(message)) !== null) {
        const value = match[1].trim().substring(0, 100);
        if (!seen.has(`error:${value}`)) {
          seen.add(`error:${value}`);
          entities.push({
            type: 'error',
            value,
            confidence: 0.95,
            context: this.extractContext(message, match.index),
          });
        }
      }
    }

    // Detect packages
    const pkgRegex = new RegExp(ENTITY_PATTERNS.package.source, 'g');
    while ((match = pkgRegex.exec(message)) !== null) {
      const value = match[1];
      if (!seen.has(`package:${value}`)) {
        seen.add(`package:${value}`);
        entities.push({
          type: 'package',
          value,
          confidence: 0.8,
          context: this.extractContext(message, match.index),
        });
      }
    }

    // Detect concepts
    const conceptRegex = new RegExp(ENTITY_PATTERNS.concept.source, 'gi');
    while ((match = conceptRegex.exec(message)) !== null) {
      const value = match[1].toLowerCase();
      if (!seen.has(`concept:${value}`)) {
        seen.add(`concept:${value}`);
        entities.push({
          type: 'concept',
          value,
          confidence: 0.7,
          context: this.extractContext(message, match.index),
        });
      }
    }

    // Sort by confidence
    entities.sort((a, b) => b.confidence - a.confidence);

    return entities;
  }

  /**
   * Extract surrounding context for an entity
   */
  private extractContext(message: string, index: number, windowSize = 50): string {
    const start = Math.max(0, index - windowSize);
    const end = Math.min(message.length, index + windowSize);
    return message.substring(start, end).trim();
  }

  /**
   * Track recently mentioned entities
   */
  private trackEntities(entities: DetectedEntity[]): void {
    const now = Date.now();
    const ttl = 5 * 60 * 1000; // 5 minutes

    // Add new entities
    for (const entity of entities) {
      this.recentEntities.set(`${entity.type}:${entity.value}`, now);
    }

    // Clean up old entities
    for (const [key, timestamp] of this.recentEntities) {
      if (now - timestamp > ttl) {
        this.recentEntities.delete(key);
      }
    }
  }

  /**
   * Fetch context for detected entities
   */
  private async fetchContextForEntities(
    entities: DetectedEntity[],
    userMessage: string,
    workingDirectory?: string
  ): Promise<ContextItem[]> {
    const contextItems: ContextItem[] = [];
    const memoryService = getMemoryService();

    // Fetch context based on entity types
    for (const entity of entities.slice(0, 5)) { // Limit to top 5 entities
      try {
        switch (entity.type) {
          case 'file':
            // Search for file-related code
            const codeResults = memoryService.searchRelevantCode(entity.value, 3);
            for (const result of codeResults) {
              contextItems.push({
                content: result.document.content,
                type: 'code',
                source: result.document.metadata.filePath || entity.value,
                relevance: result.score * entity.confidence,
                isCloud: false,
                entity: entity.value,
              });
            }
            break;

          case 'function':
          case 'class':
            // Search for function/class definitions
            const defResults = memoryService.searchRelevantCode(
              `${entity.type} ${entity.value}`,
              3
            );
            for (const result of defResults) {
              contextItems.push({
                content: result.document.content,
                type: 'code',
                source: result.document.metadata.filePath || 'codebase',
                relevance: result.score * entity.confidence,
                isCloud: false,
                entity: entity.value,
              });
            }
            break;

          case 'error':
            // Search for similar error patterns and solutions
            const errorResults = memoryService.searchKnowledge(entity.value, undefined, 3);
            for (const result of errorResults) {
              contextItems.push({
                content: result.document.content,
                type: 'knowledge',
                source: 'error_history',
                relevance: result.score * entity.confidence,
                isCloud: false,
                entity: entity.value,
              });
            }
            break;

          case 'concept':
            // Search for concept-related knowledge
            const knowledgeResults = memoryService.searchKnowledge(entity.value, undefined, 2);
            for (const result of knowledgeResults) {
              contextItems.push({
                content: result.document.content,
                type: 'knowledge',
                source: 'project_knowledge',
                relevance: result.score * entity.confidence,
                isCloud: false,
                entity: entity.value,
              });
            }
            break;

          case 'pattern':
            // Search for patterns
            if (this.config.detectPatterns) {
              const patternResults = memoryService.searchKnowledge(
                `pattern ${entity.value}`,
                undefined,
                2
              );
              for (const result of patternResults) {
                contextItems.push({
                  content: result.document.content,
                  type: 'pattern',
                  source: 'learned_patterns',
                  relevance: result.score * entity.confidence,
                  isCloud: false,
                  entity: entity.value,
                });
              }
            }
            break;
        }
      } catch (error) {
        logger.error(`Failed to fetch context for entity ${entity.value}:`, error);
      }
    }

    // Also do a general semantic search on the full message
    try {
      const semanticResults = memoryService.searchRelevantCode(userMessage, 3);
      for (const result of semanticResults) {
        // Avoid duplicates
        if (!contextItems.some(c => c.content === result.document.content)) {
          contextItems.push({
            content: result.document.content,
            type: 'code',
            source: result.document.metadata.filePath || 'semantic_search',
            relevance: result.score * 0.8, // Slightly lower weight for general search
            isCloud: false,
          });
        }
      }
    } catch (error) {
      logger.error('Failed to perform semantic search:', error);
    }

    // Cloud search if enabled
    if (this.config.enableCloudSearch) {
      try {
        const vectorStore = getVectorStore();
        const cloudResults = await vectorStore.searchCloud(userMessage, {
          topK: 3,
          threshold: 0.6,
          projectPath: workingDirectory,
        });

        for (const result of cloudResults) {
          if (!contextItems.some(c => c.content === result.content)) {
            contextItems.push({
              content: result.content,
              type: result.source === 'pattern' ? 'pattern' : 'knowledge',
              source: `cloud:${result.projectPath || 'global'}`,
              relevance: result.similarity * 0.9,
              isCloud: true,
            });
          }
        }
      } catch (error) {
        logger.error('Cloud search failed:', error);
      }
    }

    return contextItems;
  }

  /**
   * Filter context items by relevance threshold
   */
  private filterByRelevance(items: ContextItem[]): ContextItem[] {
    return items
      .filter(item => item.relevance >= this.config.minRelevance)
      .sort((a, b) => b.relevance - a.relevance);
  }

  /**
   * Truncate context to fit within limits
   */
  private truncateContext(items: ContextItem[]): ContextItem[] {
    const result: ContextItem[] = [];
    let totalLength = 0;

    for (const item of items) {
      if (result.length >= this.config.maxContextItems) break;
      if (totalLength + item.content.length > this.config.maxContextLength) {
        // Try to fit a truncated version
        const remaining = this.config.maxContextLength - totalLength;
        if (remaining > 200) {
          result.push({
            ...item,
            content: item.content.substring(0, remaining - 3) + '...',
          });
        }
        break;
      }

      result.push(item);
      totalLength += item.content.length;
    }

    return result;
  }

  /**
   * Generate a summary of the proactive context
   */
  private generateContextSummary(
    entities: DetectedEntity[],
    context: ContextItem[]
  ): string {
    if (context.length === 0) {
      return '';
    }

    const parts: string[] = [];

    // Entity summary
    const entityTypes = [...new Set(entities.map(e => e.type))];
    if (entityTypes.length > 0) {
      parts.push(`Detected: ${entityTypes.join(', ')}`);
    }

    // Context type summary
    const contextTypes = [...new Set(context.map(c => c.type))];
    parts.push(`Found: ${context.length} relevant items (${contextTypes.join(', ')})`);

    // Cloud indicator
    const cloudCount = context.filter(c => c.isCloud).length;
    if (cloudCount > 0) {
      parts.push(`(${cloudCount} from cloud)`);
    }

    return parts.join(' | ');
  }

  /**
   * Format context for injection into system prompt
   */
  formatContextForPrompt(result: ProactiveContextResult): string {
    if (result.context.length === 0) {
      return '';
    }

    const sections: string[] = [];

    // Group by type
    const byType = new Map<string, ContextItem[]>();
    for (const item of result.context) {
      const existing = byType.get(item.type) || [];
      existing.push(item);
      byType.set(item.type, existing);
    }

    // Format each section
    for (const [type, items] of byType) {
      const typeLabel = {
        code: '📄 Relevant Code',
        knowledge: '💡 Project Knowledge',
        pattern: '🔄 Learned Patterns',
        history: '📜 Conversation History',
      }[type] || type;

      sections.push(`### ${typeLabel}\n`);

      for (const item of items.slice(0, 3)) { // Max 3 items per type
        const sourceLabel = item.isCloud ? `☁️ ${item.source}` : item.source;
        sections.push(`**Source:** ${sourceLabel}`);
        if (item.entity) {
          sections.push(`**Related to:** ${item.entity}`);
        }
        sections.push('```');
        sections.push(item.content.substring(0, 500));
        if (item.content.length > 500) sections.push('...');
        sections.push('```\n');
      }
    }

    return `## 🔍 Proactive Context (Auto-retrieved)

${result.summary}

${sections.join('\n')}

---
`;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ProactiveContextConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): ProactiveContextConfig {
    return { ...this.config };
  }

  /**
   * Clear recent entities cache
   */
  clearCache(): void {
    this.recentEntities.clear();
  }
}

/**
 * Get singleton instance
 */
export function getProactiveContextService(): ProactiveContextService {
  if (!proactiveContextService) {
    proactiveContextService = new ProactiveContextService();
  }
  return proactiveContextService;
}

/**
 * Initialize with custom config
 */
export function initProactiveContextService(
  config: Partial<ProactiveContextConfig>
): ProactiveContextService {
  proactiveContextService = new ProactiveContextService(config);
  return proactiveContextService;
}
