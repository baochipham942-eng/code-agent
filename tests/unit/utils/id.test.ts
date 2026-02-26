// ============================================================================
// ID Utils Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  generateMessageId,
  generateToolCallId,
  generateSessionId,
  generatePermissionRequestId,
  isValidId,
  getIdSource,
  normalizeId,
  type IdSource,
} from '../../../src/shared/utils/id';

describe('ID Utilities', () => {
  // --------------------------------------------------------------------------
  // generateMessageId
  // --------------------------------------------------------------------------
  describe('generateMessageId', () => {
    it('should generate a valid UUID v4', () => {
      const id = generateMessageId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('should generate unique IDs on each call', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateMessageId()));
      expect(ids.size).toBe(100);
    });
  });

  // --------------------------------------------------------------------------
  // generateToolCallId
  // --------------------------------------------------------------------------
  describe('generateToolCallId', () => {
    it('should generate an ID with "tool-" prefix', () => {
      const id = generateToolCallId();
      expect(id).toMatch(/^tool-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 50 }, () => generateToolCallId()));
      expect(ids.size).toBe(50);
    });
  });

  // --------------------------------------------------------------------------
  // generateSessionId
  // --------------------------------------------------------------------------
  describe('generateSessionId', () => {
    it('should generate a valid UUID v4', () => {
      const id = generateSessionId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });

  // --------------------------------------------------------------------------
  // generatePermissionRequestId
  // --------------------------------------------------------------------------
  describe('generatePermissionRequestId', () => {
    it('should generate an ID with "perm-" prefix', () => {
      const id = generatePermissionRequestId();
      expect(id).toMatch(/^perm-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });

  // --------------------------------------------------------------------------
  // isValidId
  // --------------------------------------------------------------------------
  describe('isValidId', () => {
    it('should accept UUID v4 format', () => {
      expect(isValidId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it('should accept tool- prefixed IDs', () => {
      expect(isValidId('tool-550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it('should accept OpenAI call_ prefixed IDs', () => {
      expect(isValidId('call_abc123def456')).toBe(true);
    });

    it('should accept Claude toolu_ prefixed IDs', () => {
      expect(isValidId('toolu_01ABC123')).toBe(true);
    });

    it('should reject empty string', () => {
      expect(isValidId('')).toBe(false);
    });

    it('should reject null-like inputs', () => {
      expect(isValidId(null as unknown as string)).toBe(false);
      expect(isValidId(undefined as unknown as string)).toBe(false);
    });

    it('should reject non-string inputs', () => {
      expect(isValidId(123 as unknown as string)).toBe(false);
    });

    it('should reject random strings', () => {
      expect(isValidId('hello-world')).toBe(false);
      expect(isValidId('abc')).toBe(false);
    });

    it('should accept case-insensitive UUIDs', () => {
      expect(isValidId('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // getIdSource
  // --------------------------------------------------------------------------
  describe('getIdSource', () => {
    it('should identify UUID format', () => {
      expect(getIdSource('550e8400-e29b-41d4-a716-446655440000')).toBe('uuid');
    });

    it('should identify tool- prefixed IDs', () => {
      expect(getIdSource('tool-550e8400-e29b-41d4-a716-446655440000')).toBe('tool');
    });

    it('should identify OpenAI format', () => {
      expect(getIdSource('call_abc123')).toBe('openai');
    });

    it('should identify Claude format', () => {
      expect(getIdSource('toolu_01ABC')).toBe('claude');
    });

    it('should identify legacy timestamp format', () => {
      expect(getIdSource('1672531200000')).toBe('legacy');
    });

    it('should identify legacy timestamp-hash format', () => {
      expect(getIdSource('1672531200-abc123')).toBe('legacy');
    });

    it('should return unknown for unrecognized formats', () => {
      expect(getIdSource('hello-world')).toBe('unknown');
      expect(getIdSource('some_random_text')).toBe('unknown');
    });

    it('should return unknown for empty/null input', () => {
      expect(getIdSource('')).toBe('unknown');
      expect(getIdSource(null as unknown as string)).toBe('unknown');
      expect(getIdSource(undefined as unknown as string)).toBe('unknown');
    });
  });

  // --------------------------------------------------------------------------
  // normalizeId
  // --------------------------------------------------------------------------
  describe('normalizeId', () => {
    it('should preserve UUID format as-is', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      expect(normalizeId(uuid)).toBe(uuid);
    });

    it('should preserve OpenAI format as-is', () => {
      const id = 'call_abc123';
      expect(normalizeId(id)).toBe(id);
    });

    it('should preserve Claude format as-is', () => {
      const id = 'toolu_01ABC';
      expect(normalizeId(id)).toBe(id);
    });

    it('should preserve tool- format as-is', () => {
      const id = 'tool-550e8400-e29b-41d4-a716-446655440000';
      expect(normalizeId(id)).toBe(id);
    });

    it('should migrate legacy timestamp IDs', () => {
      const legacyId = '1672531200000';
      const normalized = normalizeId(legacyId);
      expect(normalized).toMatch(/^migrated-16725312-[0-9a-f]{8}$/);
    });

    it('should migrate unknown format IDs', () => {
      const unknownId = 'some_random_text';
      const normalized = normalizeId(unknownId);
      expect(normalized).toMatch(/^migrated-some_ran-[0-9a-f]{8}$/);
    });

    it('should include original ID prefix in migrated format', () => {
      const id = 'abcdefghijklmnop';
      const normalized = normalizeId(id);
      expect(normalized.startsWith('migrated-abcdefgh-')).toBe(true);
    });
  });
});
