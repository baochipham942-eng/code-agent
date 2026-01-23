// ============================================================================
// Graph Types Tests
// ============================================================================
//
// Tests for the type definitions of the Memory Graph system.
// These tests verify type guards, default values, and type constraints.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  type GraphEntity,
  type GraphEntityCreateInput,
  type EntityType,
  type CodeEntityType,
  type ConversationEntityType,
  type KnowledgeEntityType,
  type EntitySource,
  CODE_ENTITY_TYPES,
  CONVERSATION_ENTITY_TYPES,
  KNOWLEDGE_ENTITY_TYPES,
  ALL_ENTITY_TYPES,
  isCodeEntityType,
  isConversationEntityType,
  isKnowledgeEntityType,
  isValidEntityType,
  getEntityTypeCategory,
} from '../../../src/main/graph/types/entities';

import {
  type GraphRelation,
  type GraphRelationCreateInput,
  type RelationType,
  CODE_RELATION_TYPES,
  SEMANTIC_RELATION_TYPES,
  TEMPORAL_RELATION_TYPES,
  ALL_RELATION_TYPES,
  isCodeRelationType,
  isSemanticRelationType,
  isTemporalRelationType,
  isValidRelationType,
  getRelationTypeCategory,
} from '../../../src/main/graph/types/relationships';

// ============================================================================
// Entity Type Tests
// ============================================================================

describe('Entity Types', () => {
  // --------------------------------------------------------------------------
  // Type Constants
  // --------------------------------------------------------------------------
  describe('Type Constants', () => {
    it('should have correct code entity types', () => {
      expect(CODE_ENTITY_TYPES).toContain('function');
      expect(CODE_ENTITY_TYPES).toContain('class');
      expect(CODE_ENTITY_TYPES).toContain('interface');
      expect(CODE_ENTITY_TYPES).toContain('module');
      expect(CODE_ENTITY_TYPES).toContain('variable');
      expect(CODE_ENTITY_TYPES).toContain('type_alias');
      // Also includes 'enum'
      expect(CODE_ENTITY_TYPES.length).toBeGreaterThanOrEqual(6);
    });

    it('should have correct conversation entity types', () => {
      expect(CONVERSATION_ENTITY_TYPES).toContain('user_preference');
      expect(CONVERSATION_ENTITY_TYPES).toContain('decision');
      expect(CONVERSATION_ENTITY_TYPES).toContain('requirement');
      expect(CONVERSATION_ENTITY_TYPES).toContain('error_pattern');
      // May include 'constraint' and others
      expect(CONVERSATION_ENTITY_TYPES.length).toBeGreaterThanOrEqual(4);
    });

    it('should have correct knowledge entity types', () => {
      expect(KNOWLEDGE_ENTITY_TYPES).toContain('architecture_pattern');
      expect(KNOWLEDGE_ENTITY_TYPES).toContain('api_endpoint');
      expect(KNOWLEDGE_ENTITY_TYPES).toContain('dependency');
      expect(KNOWLEDGE_ENTITY_TYPES).toContain('concept');
      expect(KNOWLEDGE_ENTITY_TYPES.length).toBeGreaterThanOrEqual(4);
    });

    it('should have ALL_ENTITY_TYPES containing all types', () => {
      const expectedCount =
        CODE_ENTITY_TYPES.length +
        CONVERSATION_ENTITY_TYPES.length +
        KNOWLEDGE_ENTITY_TYPES.length;
      expect(ALL_ENTITY_TYPES.length).toBe(expectedCount);
    });
  });

  // --------------------------------------------------------------------------
  // Type Guards
  // --------------------------------------------------------------------------
  describe('Type Guards', () => {
    it('should correctly identify code entity types', () => {
      expect(isCodeEntityType('function')).toBe(true);
      expect(isCodeEntityType('class')).toBe(true);
      expect(isCodeEntityType('user_preference')).toBe(false);
      expect(isCodeEntityType('invalid' as EntityType)).toBe(false);
    });

    it('should correctly identify conversation entity types', () => {
      expect(isConversationEntityType('user_preference')).toBe(true);
      expect(isConversationEntityType('decision')).toBe(true);
      expect(isConversationEntityType('function')).toBe(false);
      expect(isConversationEntityType('invalid' as EntityType)).toBe(false);
    });

    it('should correctly identify knowledge entity types', () => {
      expect(isKnowledgeEntityType('architecture_pattern')).toBe(true);
      expect(isKnowledgeEntityType('concept')).toBe(true);
      expect(isKnowledgeEntityType('function')).toBe(false);
      expect(isKnowledgeEntityType('invalid' as EntityType)).toBe(false);
    });

    it('should validate entity types', () => {
      expect(isValidEntityType('function')).toBe(true);
      expect(isValidEntityType('user_preference')).toBe(true);
      expect(isValidEntityType('concept')).toBe(true);
      expect(isValidEntityType('invalid')).toBe(false);
      expect(isValidEntityType('')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Category Detection
  // --------------------------------------------------------------------------
  describe('Category Detection', () => {
    it('should return correct category for code entities', () => {
      expect(getEntityTypeCategory('function')).toBe('code');
      expect(getEntityTypeCategory('class')).toBe('code');
      expect(getEntityTypeCategory('interface')).toBe('code');
    });

    it('should return correct category for conversation entities', () => {
      expect(getEntityTypeCategory('user_preference')).toBe('conversation');
      expect(getEntityTypeCategory('decision')).toBe('conversation');
      expect(getEntityTypeCategory('requirement')).toBe('conversation');
    });

    it('should return correct category for knowledge entities', () => {
      expect(getEntityTypeCategory('architecture_pattern')).toBe('knowledge');
      expect(getEntityTypeCategory('concept')).toBe('knowledge');
      expect(getEntityTypeCategory('dependency')).toBe('knowledge');
    });

    it('should return undefined for invalid types', () => {
      expect(getEntityTypeCategory('invalid' as EntityType)).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Entity Create Input
  // --------------------------------------------------------------------------
  describe('Entity Create Input', () => {
    it('should accept minimal valid input', () => {
      const input: GraphEntityCreateInput = {
        type: 'function',
        name: 'handleClick',
        content: 'function handleClick() { }',
        source: 'code_analysis',
      };

      expect(input.type).toBe('function');
      expect(input.name).toBe('handleClick');
      expect(input.source).toBe('code_analysis');
    });

    it('should accept input with location', () => {
      const input: GraphEntityCreateInput = {
        type: 'function',
        name: 'handleClick',
        content: 'function handleClick() { }',
        source: 'code_analysis',
        location: {
          filePath: '/src/components/Button.tsx',
          startLine: 10,
          endLine: 15,
        },
      };

      expect(input.location?.filePath).toBe('/src/components/Button.tsx');
      expect(input.location?.startLine).toBe(10);
      expect(input.location?.endLine).toBe(15);
    });

    it('should accept input with metadata', () => {
      const input: GraphEntityCreateInput = {
        type: 'user_preference',
        name: 'coding_style',
        content: 'Prefer functional components',
        source: 'conversation',
        metadata: {
          sessionId: 'session-123',
          importance: 'high',
        },
      };

      expect(input.metadata?.sessionId).toBe('session-123');
      expect(input.metadata?.importance).toBe('high');
    });
  });
});

// ============================================================================
// Relation Type Tests
// ============================================================================

describe('Relation Types', () => {
  // --------------------------------------------------------------------------
  // Type Constants
  // --------------------------------------------------------------------------
  describe('Type Constants', () => {
    it('should have correct code relation types', () => {
      expect(CODE_RELATION_TYPES).toContain('calls');
      expect(CODE_RELATION_TYPES).toContain('imports');
      expect(CODE_RELATION_TYPES).toContain('extends');
      expect(CODE_RELATION_TYPES).toContain('implements');
      expect(CODE_RELATION_TYPES).toContain('uses');
      expect(CODE_RELATION_TYPES).toContain('defines');
      expect(CODE_RELATION_TYPES).toContain('contains');
      expect(CODE_RELATION_TYPES.length).toBe(7);
    });

    it('should have correct semantic relation types', () => {
      expect(SEMANTIC_RELATION_TYPES).toContain('related_to');
      expect(SEMANTIC_RELATION_TYPES).toContain('solves');
      expect(SEMANTIC_RELATION_TYPES).toContain('conflicts_with');
      expect(SEMANTIC_RELATION_TYPES).toContain('depends_on');
      expect(SEMANTIC_RELATION_TYPES).toContain('similar_to');
      expect(SEMANTIC_RELATION_TYPES.length).toBe(5);
    });

    it('should have correct temporal relation types', () => {
      expect(TEMPORAL_RELATION_TYPES).toContain('supersedes');
      expect(TEMPORAL_RELATION_TYPES).toContain('derived_from');
      expect(TEMPORAL_RELATION_TYPES).toContain('precedes');
      expect(TEMPORAL_RELATION_TYPES.length).toBe(3);
    });

    it('should have ALL_RELATION_TYPES containing all types', () => {
      const expectedCount =
        CODE_RELATION_TYPES.length +
        SEMANTIC_RELATION_TYPES.length +
        TEMPORAL_RELATION_TYPES.length;
      expect(ALL_RELATION_TYPES.length).toBe(expectedCount);
    });
  });

  // --------------------------------------------------------------------------
  // Type Guards
  // --------------------------------------------------------------------------
  describe('Type Guards', () => {
    it('should correctly identify code relation types', () => {
      expect(isCodeRelationType('calls')).toBe(true);
      expect(isCodeRelationType('imports')).toBe(true);
      expect(isCodeRelationType('related_to')).toBe(false);
      expect(isCodeRelationType('invalid' as RelationType)).toBe(false);
    });

    it('should correctly identify semantic relation types', () => {
      expect(isSemanticRelationType('related_to')).toBe(true);
      expect(isSemanticRelationType('solves')).toBe(true);
      expect(isSemanticRelationType('calls')).toBe(false);
      expect(isSemanticRelationType('invalid' as RelationType)).toBe(false);
    });

    it('should correctly identify temporal relation types', () => {
      expect(isTemporalRelationType('supersedes')).toBe(true);
      expect(isTemporalRelationType('derived_from')).toBe(true);
      expect(isTemporalRelationType('calls')).toBe(false);
      expect(isTemporalRelationType('invalid' as RelationType)).toBe(false);
    });

    it('should validate relation types', () => {
      expect(isValidRelationType('calls')).toBe(true);
      expect(isValidRelationType('related_to')).toBe(true);
      expect(isValidRelationType('supersedes')).toBe(true);
      expect(isValidRelationType('invalid')).toBe(false);
      expect(isValidRelationType('')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Category Detection
  // --------------------------------------------------------------------------
  describe('Category Detection', () => {
    it('should return correct category for code relations', () => {
      expect(getRelationTypeCategory('calls')).toBe('code');
      expect(getRelationTypeCategory('imports')).toBe('code');
      expect(getRelationTypeCategory('extends')).toBe('code');
    });

    it('should return correct category for semantic relations', () => {
      expect(getRelationTypeCategory('related_to')).toBe('semantic');
      expect(getRelationTypeCategory('solves')).toBe('semantic');
      expect(getRelationTypeCategory('conflicts_with')).toBe('semantic');
    });

    it('should return correct category for temporal relations', () => {
      expect(getRelationTypeCategory('supersedes')).toBe('temporal');
      expect(getRelationTypeCategory('derived_from')).toBe('temporal');
      expect(getRelationTypeCategory('precedes')).toBe('temporal');
    });

    it('should return undefined for invalid types', () => {
      expect(getRelationTypeCategory('invalid' as RelationType)).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Relation Create Input
  // --------------------------------------------------------------------------
  describe('Relation Create Input', () => {
    it('should accept minimal valid input', () => {
      const input: GraphRelationCreateInput = {
        fromId: 'entity-1',
        toId: 'entity-2',
        type: 'calls',
      };

      expect(input.fromId).toBe('entity-1');
      expect(input.toId).toBe('entity-2');
      expect(input.type).toBe('calls');
    });

    it('should accept input with weight and confidence', () => {
      const input: GraphRelationCreateInput = {
        fromId: 'entity-1',
        toId: 'entity-2',
        type: 'related_to',
        weight: 0.8,
        confidence: 0.9,
      };

      expect(input.weight).toBe(0.8);
      expect(input.confidence).toBe(0.9);
    });

    it('should accept input with metadata', () => {
      const input: GraphRelationCreateInput = {
        fromId: 'entity-1',
        toId: 'entity-2',
        type: 'solves',
        metadata: {
          context: 'Bug fix for issue #123',
          verifiedBy: 'user',
        },
      };

      expect(input.metadata?.context).toBe('Bug fix for issue #123');
      expect(input.metadata?.verifiedBy).toBe('user');
    });
  });
});
