// ============================================================================
// Generation Manager - Manages different Claude Code generations
// ============================================================================

import type { Generation, GenerationId, GenerationDiff } from '../../shared/types';
import * as diff from 'diff';
import { GENERATION_DEFINITIONS } from './metadata';
import { getSystemPrompt } from '../services/PromptService';

// ----------------------------------------------------------------------------
// Generation Manager Class
// ----------------------------------------------------------------------------

export class GenerationManager {
  private generations: Map<GenerationId, Generation> = new Map();
  private currentGeneration: Generation;

  constructor() {
    this.loadGenerations();
    this.currentGeneration = this.generations.get('gen3')!;
  }

  private loadGenerations(): void {
    console.log('[GenerationManager] Loading generations...');
    console.log('[GenerationManager] GENERATION_DEFINITIONS keys:', Object.keys(GENERATION_DEFINITIONS));
    for (const [id, definition] of Object.entries(GENERATION_DEFINITIONS)) {
      const genId = id as GenerationId;
      this.generations.set(genId, {
        ...definition,
        systemPrompt: getSystemPrompt(genId), // 使用 PromptService（云端优先 + 本地降级）
      });
    }
    console.log('[GenerationManager] Loaded generations:', Array.from(this.generations.keys()));
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  getAllGenerations(): Generation[] {
    return Array.from(this.generations.values());
  }

  getGeneration(id: GenerationId): Generation | undefined {
    return this.generations.get(id);
  }

  getCurrentGeneration(): Generation {
    return this.currentGeneration;
  }

  switchGeneration(id: GenerationId): Generation {
    const generation = this.generations.get(id);
    if (!generation) {
      throw new Error(`Unknown generation: ${id}`);
    }
    this.currentGeneration = generation;
    return generation;
  }

  getPrompt(id: GenerationId): string {
    const generation = this.generations.get(id);
    if (!generation) {
      throw new Error(`Unknown generation: ${id}`);
    }
    return generation.systemPrompt;
  }

  compareGenerations(id1: GenerationId, id2: GenerationId): GenerationDiff {
    const gen1 = this.generations.get(id1);
    const gen2 = this.generations.get(id2);

    if (!gen1 || !gen2) {
      throw new Error('Invalid generation IDs');
    }

    const changes = diff.diffLines(gen1.systemPrompt, gen2.systemPrompt);

    const result: GenerationDiff = {
      added: [],
      removed: [],
      modified: [],
    };

    for (const change of changes) {
      const lines = change.value.split('\n').filter((l) => l.trim());

      if (change.added) {
        result.added.push(...lines);
      } else if (change.removed) {
        result.removed.push(...lines);
      }
    }

    return result;
  }

  // Get available tools for a generation
  getGenerationTools(id: GenerationId): string[] {
    const generation = this.generations.get(id);
    return generation?.tools || [];
  }
}
