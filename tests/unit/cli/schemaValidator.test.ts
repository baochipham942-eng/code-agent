import { describe, expect, it } from 'vitest';
import { formatValidationErrors, validateSchema } from '../../../src/cli/utils/schemaValidator';

describe('CLI schemaValidator', () => {
  it('accepts integers for number schemas and distinguishes integer schemas', () => {
    expect(validateSchema(1, { type: 'number' })).toEqual({ valid: true, errors: [] });

    const result = validateSchema(1.5, { type: 'integer' });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({ path: '/' });
  });

  it('validates nested required fields and array item constraints', () => {
    const result = validateSchema(
      {
        name: 'neo',
        tasks: [{ title: 'ok' }, { title: '' }],
      },
      {
        type: 'object',
        required: ['name', 'tasks'],
        properties: {
          name: { type: 'string', minLength: 2 },
          tasks: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['title'],
              properties: {
                title: { type: 'string', minLength: 1 },
              },
            },
          },
        },
      },
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({ path: 'tasks[1].title' }),
    ]);
  });

  it('rejects or validates additional properties when configured', () => {
    const rejected = validateSchema(
      { id: 'task-1', unexpected: true },
      {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        additionalProperties: false,
      },
    );

    expect(rejected.valid).toBe(false);
    expect(rejected.errors).toEqual([
      expect.objectContaining({ path: 'unexpected' }),
    ]);

    const validated = validateSchema(
      { id: 'task-1', retries: 2, note: 'bad' },
      {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        additionalProperties: { type: 'number' },
      },
    );

    expect(validated.valid).toBe(false);
    expect(validated.errors).toEqual([
      expect.objectContaining({ path: 'note' }),
    ]);
  });

  it('formats validation errors for CLI output', () => {
    expect(formatValidationErrors([
      { path: 'name', message: 'required' },
      { path: 'tasks[0]', message: 'invalid' },
    ])).toBe('  - name: required\n  - tasks[0]: invalid');
  });
});
