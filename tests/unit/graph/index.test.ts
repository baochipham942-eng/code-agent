// ============================================================================
// Graph Module Integration Tests
// ============================================================================
//
// Tests for the graph module exports and initialization.
// ============================================================================

import { describe, it, expect } from 'vitest';

describe('Graph Module Exports', () => {
  it('should export type definitions', async () => {
    const types = await import('../../../src/main/graph/types');

    // Entity types
    expect(types.CODE_ENTITY_TYPES).toBeDefined();
    expect(types.CONVERSATION_ENTITY_TYPES).toBeDefined();
    expect(types.KNOWLEDGE_ENTITY_TYPES).toBeDefined();
    expect(types.ALL_ENTITY_TYPES).toBeDefined();

    // Entity type guards
    expect(types.isCodeEntityType).toBeDefined();
    expect(types.isConversationEntityType).toBeDefined();
    expect(types.isKnowledgeEntityType).toBeDefined();
    expect(types.isValidEntityType).toBeDefined();
    expect(types.getEntityTypeCategory).toBeDefined();

    // Relation types
    expect(types.CODE_RELATION_TYPES).toBeDefined();
    expect(types.SEMANTIC_RELATION_TYPES).toBeDefined();
    expect(types.TEMPORAL_RELATION_TYPES).toBeDefined();
    expect(types.ALL_RELATION_TYPES).toBeDefined();

    // Relation type guards
    expect(types.isCodeRelationType).toBeDefined();
    expect(types.isSemanticRelationType).toBeDefined();
    expect(types.isTemporalRelationType).toBeDefined();
    expect(types.isValidRelationType).toBeDefined();
    expect(types.getRelationTypeCategory).toBeDefined();
  });

  it('should export store classes', async () => {
    const store = await import('../../../src/main/graph/store');

    expect(store.GraphStore).toBeDefined();
    expect(store.HybridStore).toBeDefined();
    expect(store.initHybridStore).toBeDefined();
    expect(store.getHybridStore).toBeDefined();
  });

  it('should export main module functions', async () => {
    const graph = await import('../../../src/main/graph');

    expect(graph.initMemoryGraph).toBeDefined();
    expect(graph.getMemoryGraph).toBeDefined();
  });
});

describe('Type System Completeness', () => {
  it('should have consistent entity type categorization', async () => {
    const {
      ALL_ENTITY_TYPES,
      CODE_ENTITY_TYPES,
      CONVERSATION_ENTITY_TYPES,
      KNOWLEDGE_ENTITY_TYPES,
      getEntityTypeCategory,
    } = await import('../../../src/main/graph/types/entities');

    // Every type should have a category
    for (const type of ALL_ENTITY_TYPES) {
      const category = getEntityTypeCategory(type);
      expect(category).toBeDefined();
      expect(['code', 'conversation', 'knowledge']).toContain(category);
    }

    // Category arrays should match categorization function
    for (const type of CODE_ENTITY_TYPES) {
      expect(getEntityTypeCategory(type)).toBe('code');
    }

    for (const type of CONVERSATION_ENTITY_TYPES) {
      expect(getEntityTypeCategory(type)).toBe('conversation');
    }

    for (const type of KNOWLEDGE_ENTITY_TYPES) {
      expect(getEntityTypeCategory(type)).toBe('knowledge');
    }
  });

  it('should have consistent relation type categorization', async () => {
    const {
      ALL_RELATION_TYPES,
      CODE_RELATION_TYPES,
      SEMANTIC_RELATION_TYPES,
      TEMPORAL_RELATION_TYPES,
      getRelationTypeCategory,
    } = await import('../../../src/main/graph/types/relationships');

    // Every type should have a category
    for (const type of ALL_RELATION_TYPES) {
      const category = getRelationTypeCategory(type);
      expect(category).toBeDefined();
      expect(['code', 'semantic', 'temporal']).toContain(category);
    }

    // Category arrays should match categorization function
    for (const type of CODE_RELATION_TYPES) {
      expect(getRelationTypeCategory(type)).toBe('code');
    }

    for (const type of SEMANTIC_RELATION_TYPES) {
      expect(getRelationTypeCategory(type)).toBe('semantic');
    }

    for (const type of TEMPORAL_RELATION_TYPES) {
      expect(getRelationTypeCategory(type)).toBe('temporal');
    }
  });
});
