// ============================================================================
// Generation Manager - Manages different Claude Code generations
// ============================================================================
// Simplified: locked to gen8 only (Sprint 1)

import type { Generation, GenerationId, GenerationDiff } from '../../shared/types';
import { GENERATION_DEFINITIONS } from './metadata';
import { getSystemPrompt } from '../services/cloud/promptService';
import { createLogger } from '../services/infra/logger';
import { DEFAULT_GENERATION } from '../../shared/constants';

const logger = createLogger('GenerationManager');

// ----------------------------------------------------------------------------
// Generation Manager Class
// ----------------------------------------------------------------------------

export class GenerationManager {
  private generations: Map<GenerationId, Generation> = new Map();
  private currentGeneration: Generation;

  constructor() {
    this.loadGenerations();
    this.currentGeneration = this.generations.get(DEFAULT_GENERATION)!;
  }

  private loadGenerations(): void {
    logger.info(' Loading generations...');
    logger.info(' GENERATION_DEFINITIONS keys:', Object.keys(GENERATION_DEFINITIONS));
    for (const [id, definition] of Object.entries(GENERATION_DEFINITIONS)) {
      const genId = id as GenerationId;
      this.generations.set(genId, {
        ...definition,
        systemPrompt: getSystemPrompt(genId), // 使用 PromptService（云端优先 + 本地降级）
      });
    }
    logger.info(' Loaded generations:', Array.from(this.generations.keys()));
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  /** @simplified Always returns only gen8 */
  getAllGenerations(): Generation[] {
    const gen8 = this.generations.get(DEFAULT_GENERATION);
    return gen8 ? [gen8] : [];
  }

  getGeneration(id: GenerationId): Generation | undefined {
    return this.generations.get(id);
  }

  getCurrentGeneration(): Generation {
    return this.currentGeneration;
  }

  /** @simplified Always returns gen8, ignores requested id */
  switchGeneration(id: GenerationId): Generation {
    if (id !== DEFAULT_GENERATION) {
      logger.warn(`switchGeneration(${id}) called but locked to ${DEFAULT_GENERATION}`);
    }
    return this.currentGeneration; // always gen8
  }

  getPrompt(id: GenerationId): string {
    // Always return gen8 prompt regardless of requested id
    const generation = this.generations.get(DEFAULT_GENERATION);
    if (!generation) {
      throw new Error(`Generation ${DEFAULT_GENERATION} not found`);
    }
    return generation.systemPrompt;
  }

  /** @simplified Always returns empty diff */
  compareGenerations(_id1: GenerationId, _id2: GenerationId): GenerationDiff {
    return { added: [], removed: [], modified: [] };
  }

  /** @simplified Returns gen8 tools regardless of id */
  getGenerationTools(_id: GenerationId): string[] {
    const generation = this.generations.get(DEFAULT_GENERATION);
    return generation?.tools || [];
  }
}
