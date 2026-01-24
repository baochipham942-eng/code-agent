// ============================================================================
// Graph Store Tests
// ============================================================================
//
// Tests for the Kuzu graph database wrapper.
// Note: These tests require the kuzu native module to be properly installed.
// If kuzu installation fails, these tests will be skipped.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GraphStore } from '../../../src/main/graph/store/graphStore';
import type { GraphEntityCreateInput } from '../../../src/main/graph/types/entities';
import type { GraphRelationCreateInput } from '../../../src/main/graph/types/relationships';

// Check if kuzu is available
let kuzuAvailable = true;
try {
  // Dynamic import to check availability
  await import('kuzu');
} catch {
  kuzuAvailable = false;
}

// Skip all tests if kuzu is not available
const describeWithKuzu = kuzuAvailable ? describe : describe.skip;

describeWithKuzu('GraphStore', () => {
  let store: GraphStore;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = path.join(os.tmpdir(), `graph-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(async () => {
    // 使用 uuid 生成唯一路径，避免重复
    const uniqueId = Math.random().toString(36).substring(2, 15);
    const dbPath = path.join(tempDir, `test-${uniqueId}`);
    // 确保路径不存在
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { recursive: true, force: true });
    }
    store = new GraphStore({ dbPath });
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
  });

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------
  describe('Initialization', () => {
    it('should initialize successfully', async () => {
      expect(store).toBeDefined();
      const stats = await store.getStats();
      expect(stats.entityCount).toBe(0);
      expect(stats.relationCount).toBe(0);
    });

    it('should create necessary schema tables', async () => {
      // If initialization succeeded, schema tables should exist
      // We verify by trying to create an entity
      const entityId = await store.createEntity({
        type: 'function',
        name: 'test',
        content: 'function test() {}',
        source: 'code_analysis',
      });
      expect(entityId).toBeDefined();
      expect(typeof entityId).toBe('string');
    });
  });

  // --------------------------------------------------------------------------
  // Entity CRUD Operations
  // --------------------------------------------------------------------------
  describe('Entity CRUD', () => {
    it('should create an entity', async () => {
      const input: GraphEntityCreateInput = {
        type: 'function',
        name: 'handleClick',
        content: 'function handleClick() { console.log("clicked"); }',
        source: 'code_analysis',
        location: {
          filePath: '/src/Button.tsx',
          startLine: 10,
          endLine: 12,
        },
      };

      const entityId = await store.createEntity(input);
      expect(entityId).toBeDefined();
      expect(entityId).toMatch(/^entity_/);
    });

    it('should retrieve an entity by id', async () => {
      const input: GraphEntityCreateInput = {
        type: 'class',
        name: 'UserService',
        content: 'class UserService { }',
        source: 'code_analysis',
      };

      const entityId = await store.createEntity(input);
      const entity = await store.getEntity(entityId);

      expect(entity).toBeDefined();
      expect(entity?.id).toBe(entityId);
      expect(entity?.type).toBe('class');
      expect(entity?.name).toBe('UserService');
      expect(entity?.content).toBe('class UserService { }');
      expect(entity?.source).toBe('code_analysis');
    });

    it('should return null for non-existent entity', async () => {
      const entity = await store.getEntity('non-existent-id');
      expect(entity).toBeNull();
    });

    it('should update an entity', async () => {
      const entityId = await store.createEntity({
        type: 'function',
        name: 'oldName',
        content: 'function oldName() {}',
        source: 'code_analysis',
      });

      await store.updateEntity(entityId, {
        name: 'newName',
        content: 'function newName() { return true; }',
      });

      const entity = await store.getEntity(entityId);
      expect(entity?.name).toBe('newName');
      expect(entity?.content).toBe('function newName() { return true; }');
    });

    it('should delete an entity', async () => {
      const entityId = await store.createEntity({
        type: 'variable',
        name: 'testVar',
        content: 'const testVar = 42;',
        source: 'code_analysis',
      });

      const deleteResult = await store.deleteEntity(entityId);
      expect(deleteResult).toBe(true);

      const entity = await store.getEntity(entityId);
      expect(entity).toBeNull();
    });

    it('should return false when deleting non-existent entity', async () => {
      const deleteResult = await store.deleteEntity('non-existent-id');
      expect(deleteResult).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Entity Queries
  // --------------------------------------------------------------------------
  describe('Entity Queries', () => {
    beforeEach(async () => {
      // Create test entities
      await store.createEntity({
        type: 'function',
        name: 'func1',
        content: 'function func1() {}',
        source: 'code_analysis',
        location: { filePath: '/src/utils.ts', startLine: 1, endLine: 3 },
      });

      await store.createEntity({
        type: 'function',
        name: 'func2',
        content: 'function func2() {}',
        source: 'code_analysis',
        location: { filePath: '/src/utils.ts', startLine: 5, endLine: 7 },
      });

      await store.createEntity({
        type: 'class',
        name: 'MyClass',
        content: 'class MyClass {}',
        source: 'code_analysis',
        location: { filePath: '/src/MyClass.ts', startLine: 1, endLine: 10 },
      });

      await store.createEntity({
        type: 'user_preference',
        name: 'coding_style',
        content: 'Prefer functional components',
        source: 'conversation',
        sessionId: 'session-123',
      });
    });

    it('should query entities by type', async () => {
      const functions = await store.queryEntities({ types: ['function'] });
      expect(functions.length).toBe(2);
      expect(functions.every(e => e.type === 'function')).toBe(true);
    });

    it('should query entities by source', async () => {
      const codeEntities = await store.queryEntities({ sources: ['code_analysis'] });
      expect(codeEntities.length).toBe(3);

      const convEntities = await store.queryEntities({ sources: ['conversation'] });
      expect(convEntities.length).toBe(1);
    });

    it('should query entities by file path', async () => {
      const utilsEntities = await store.queryEntities({ filePath: '/src/utils.ts' });
      expect(utilsEntities.length).toBe(2);
    });

    it('should query with limit and offset', async () => {
      const page1 = await store.queryEntities({ limit: 2, offset: 0 });
      expect(page1.length).toBe(2);

      const page2 = await store.queryEntities({ limit: 2, offset: 2 });
      expect(page2.length).toBe(2);

      // Ensure different results
      expect(page1[0].id).not.toBe(page2[0].id);
    });
  });

  // --------------------------------------------------------------------------
  // Relation CRUD Operations
  // --------------------------------------------------------------------------
  describe('Relation CRUD', () => {
    let entity1Id: string;
    let entity2Id: string;
    let entity3Id: string;

    beforeEach(async () => {
      entity1Id = await store.createEntity({
        type: 'function',
        name: 'caller',
        content: 'function caller() { callee(); }',
        source: 'code_analysis',
      });

      entity2Id = await store.createEntity({
        type: 'function',
        name: 'callee',
        content: 'function callee() {}',
        source: 'code_analysis',
      });

      entity3Id = await store.createEntity({
        type: 'class',
        name: 'Parent',
        content: 'class Parent {}',
        source: 'code_analysis',
      });
    });

    it('should create a relation', async () => {
      const input: GraphRelationCreateInput = {
        fromId: entity1Id,
        toId: entity2Id,
        type: 'calls',
      };

      const relationId = await store.createRelation(input);
      expect(relationId).toBeDefined();
      expect(relationId).toMatch(/^relation_/);
    });

    it('should create a relation with weight and confidence', async () => {
      const relationId = await store.createRelation({
        fromId: entity1Id,
        toId: entity2Id,
        type: 'related_to',
        weight: 0.8,
        confidence: 0.9,
      });

      const relation = await store.getRelation(relationId);
      expect(relation?.weight).toBe(0.8);
      expect(relation?.confidence).toBe(0.9);
    });

    it('should retrieve a relation by id', async () => {
      const relationId = await store.createRelation({
        fromId: entity1Id,
        toId: entity2Id,
        type: 'calls',
      });

      const relation = await store.getRelation(relationId);
      expect(relation).toBeDefined();
      expect(relation?.fromId).toBe(entity1Id);
      expect(relation?.toId).toBe(entity2Id);
      expect(relation?.type).toBe('calls');
    });

    it('should delete a relation', async () => {
      const relationId = await store.createRelation({
        fromId: entity1Id,
        toId: entity2Id,
        type: 'calls',
      });

      const deleteResult = await store.deleteRelation(relationId);
      expect(deleteResult).toBe(true);

      const relation = await store.getRelation(relationId);
      expect(relation).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Graph Traversal
  // --------------------------------------------------------------------------
  describe('Graph Traversal', () => {
    let funcA: string;
    let funcB: string;
    let funcC: string;
    let classX: string;

    beforeEach(async () => {
      // Create a small graph:
      // funcA --calls--> funcB --calls--> funcC
      // funcA --uses--> classX

      funcA = await store.createEntity({
        type: 'function',
        name: 'funcA',
        content: 'function funcA() { funcB(); classX.method(); }',
        source: 'code_analysis',
      });

      funcB = await store.createEntity({
        type: 'function',
        name: 'funcB',
        content: 'function funcB() { funcC(); }',
        source: 'code_analysis',
      });

      funcC = await store.createEntity({
        type: 'function',
        name: 'funcC',
        content: 'function funcC() {}',
        source: 'code_analysis',
      });

      classX = await store.createEntity({
        type: 'class',
        name: 'classX',
        content: 'class classX { method() {} }',
        source: 'code_analysis',
      });

      await store.createRelation({ fromId: funcA, toId: funcB, type: 'calls' });
      await store.createRelation({ fromId: funcB, toId: funcC, type: 'calls' });
      await store.createRelation({ fromId: funcA, toId: classX, type: 'uses' });
    });

    it('should get neighborhood with depth 1', async () => {
      const neighborhood = await store.getNeighborhood({
        entityIds: [funcA],
        depth: 1,
      });

      // Should include funcA's direct neighbors: funcB and classX
      expect(neighborhood.entities.length).toBeGreaterThanOrEqual(2);
      const names = neighborhood.entities.map(e => e.name);
      expect(names).toContain('funcB');
      expect(names).toContain('classX');
    });

    it('should get neighborhood with depth 2', async () => {
      const neighborhood = await store.getNeighborhood({
        entityIds: [funcA],
        depth: 2,
      });

      // Should include funcC at depth 2
      const names = neighborhood.entities.map(e => e.name);
      expect(names).toContain('funcC');
    });

    it('should filter neighborhood by relation type', async () => {
      const neighborhood = await store.getNeighborhood({
        entityIds: [funcA],
        depth: 2,
        relationTypes: ['calls'],
      });

      // Should only include call relations, not uses
      const names = neighborhood.entities.map(e => e.name);
      expect(names).toContain('funcB');
      expect(names).toContain('funcC');
      expect(names).not.toContain('classX');
    });

    it('should find paths between entities', async () => {
      const paths = await store.findPaths({
        fromId: funcA,
        toId: funcC,
        maxDepth: 3,
      });

      expect(paths.length).toBeGreaterThan(0);
      // Path should be: funcA -> funcB -> funcC
      const firstPath = paths[0];
      expect(firstPath.entities.length).toBe(3);
      expect(firstPath.entities[0].id).toBe(funcA);
      expect(firstPath.entities[2].id).toBe(funcC);
    });
  });

  // --------------------------------------------------------------------------
  // Entity Invalidation (Temporal)
  // --------------------------------------------------------------------------
  describe('Entity Invalidation', () => {
    it('should invalidate an entity', async () => {
      const entityId = await store.createEntity({
        type: 'function',
        name: 'oldFunc',
        content: 'function oldFunc() {}',
        source: 'code_analysis',
      });

      await store.invalidateEntity(entityId);

      const entity = await store.getEntity(entityId);
      expect(entity?.validTo).toBeDefined();
      expect(entity?.validTo).toBeLessThanOrEqual(Date.now());
    });

    it('should filter out invalid entities by default', async () => {
      const entity1Id = await store.createEntity({
        type: 'function',
        name: 'validFunc',
        content: 'function validFunc() {}',
        source: 'code_analysis',
      });

      const entity2Id = await store.createEntity({
        type: 'function',
        name: 'invalidFunc',
        content: 'function invalidFunc() {}',
        source: 'code_analysis',
      });

      await store.invalidateEntity(entity2Id);

      const entities = await store.queryEntities({
        types: ['function'],
        onlyValid: true,
      });

      expect(entities.length).toBe(1);
      expect(entities[0].name).toBe('validFunc');
    });

    it('should include invalid entities when requested', async () => {
      const entity1Id = await store.createEntity({
        type: 'function',
        name: 'validFunc',
        content: 'function validFunc() {}',
        source: 'code_analysis',
      });

      const entity2Id = await store.createEntity({
        type: 'function',
        name: 'invalidFunc',
        content: 'function invalidFunc() {}',
        source: 'code_analysis',
      });

      await store.invalidateEntity(entity2Id);

      const entities = await store.queryEntities({
        types: ['function'],
        onlyValid: false,
      });

      expect(entities.length).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // Statistics
  // --------------------------------------------------------------------------
  describe('Statistics', () => {
    beforeEach(async () => {
      // Create some entities
      await store.createEntity({
        type: 'function',
        name: 'func1',
        content: 'function func1() {}',
        source: 'code_analysis',
      });

      const entity1 = await store.createEntity({
        type: 'function',
        name: 'func2',
        content: 'function func2() {}',
        source: 'code_analysis',
      });

      const entity2 = await store.createEntity({
        type: 'class',
        name: 'MyClass',
        content: 'class MyClass {}',
        source: 'code_analysis',
      });

      await store.createRelation({
        fromId: entity1,
        toId: entity2,
        type: 'uses',
      });
    });

    it('should return correct statistics', async () => {
      const stats = await store.getStats();

      expect(stats.entityCount).toBe(3);
      expect(stats.relationCount).toBe(1);
      expect(stats.entityCountByType['function']).toBe(2);
      expect(stats.entityCountByType['class']).toBe(1);
      expect(stats.relationCountByType['uses']).toBe(1);
    });
  });
});
