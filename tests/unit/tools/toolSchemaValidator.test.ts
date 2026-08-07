import { describe, expect, it } from 'vitest';
import {
  validateToolInputSchema,
  formatToolSchemaValidationError,
} from '../../../src/host/tools/toolSchemaValidator';

// §1.2：minLength / pattern / minimum 三个新关键字各自拦得住，
// category 统一为 constraint_violation（不复用 type_mismatch）。

describe('toolSchemaValidator constraint keywords', () => {
  it('minLength blocks empty string', () => {
    const issues = validateToolInputSchema(
      { type: 'object', properties: { query: { type: 'string', minLength: 1 } } },
      { query: '' },
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      field_path: 'query',
      category: 'constraint_violation',
      expected: 'minLength 1',
    });
  });

  it('minLength lets a non-empty string through', () => {
    const issues = validateToolInputSchema(
      { type: 'object', properties: { query: { type: 'string', minLength: 1 } } },
      { query: 'x' },
    );

    expect(issues).toHaveLength(0);
  });

  it('pattern \\S blocks whitespace-only string', () => {
    const issues = validateToolInputSchema(
      { type: 'object', properties: { query: { type: 'string', minLength: 1, pattern: '\\S' } } },
      { query: '   ' },
    );

    expect(issues.some((issue) => issue.category === 'constraint_violation'
      && issue.expected === 'pattern \\S')).toBe(true);
  });

  it('pattern \\S lets a string with real content through', () => {
    const issues = validateToolInputSchema(
      { type: 'object', properties: { query: { type: 'string', pattern: '\\S' } } },
      { query: '  hello  ' },
    );

    expect(issues).toHaveLength(0);
  });

  it('minimum 1 blocks 0 and -1', () => {
    const schema = { type: 'object', properties: { line: { type: 'integer', minimum: 1 } } };

    for (const bad of [0, -1]) {
      const issues = validateToolInputSchema(schema, { line: bad });
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        field_path: 'line',
        category: 'constraint_violation',
        expected: 'minimum 1',
      });
    }
  });

  it('integer type blocks non-integer line numbers (visualEdit #5 收紧）', () => {
    const issues = validateToolInputSchema(
      { type: 'object', properties: { line: { type: 'integer', minimum: 1 } } },
      { line: 1.5 },
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.category).toBe('type_mismatch');
  });

  it('minimum 1 lets a positive integer through', () => {
    const issues = validateToolInputSchema(
      { type: 'object', properties: { line: { type: 'integer', minimum: 1 } } },
      { line: 3 },
    );

    expect(issues).toHaveLength(0);
  });

  it('formatToolSchemaValidationError renders constraint_violation issues', () => {
    const issues = validateToolInputSchema(
      { type: 'object', properties: { query: { type: 'string', minLength: 1 } } },
      { query: '' },
    );

    const message = formatToolSchemaValidationError('WebSearch', issues);
    expect(message).toContain('category=constraint_violation');
    expect(message).toContain('field_path=query');
  });
});
