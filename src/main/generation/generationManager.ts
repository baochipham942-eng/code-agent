// ============================================================================
// Generation Manager - Locked to gen8 only (Sprint 2: removed gen1-gen7)
// ============================================================================

import type { Generation, GenerationId } from '../../shared/types';
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
    for (const [id, definition] of Object.entries(GENERATION_DEFINITIONS)) {
      if (!definition) continue;
      const genId = id as GenerationId;
      this.generations.set(genId, {
        ...definition,
        systemPrompt: getSystemPrompt(genId),
      });
    }
    logger.info(' Loaded generations:', Array.from(this.generations.keys()));
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

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

  /** @simplified Always returns gen8 */
  switchGeneration(_id: GenerationId): Generation {
    return this.currentGeneration;
  }

  getPrompt(_id: GenerationId): string {
    const generation = this.generations.get(DEFAULT_GENERATION);
    if (!generation) {
      throw new Error(`Generation ${DEFAULT_GENERATION} not found`);
    }
    return generation.systemPrompt;
  }

  /** @simplified Returns gen8 tools */
  getGenerationTools(_id: GenerationId): string[] {
    const generation = this.generations.get(DEFAULT_GENERATION);
    return generation?.tools || [];
  }
}
