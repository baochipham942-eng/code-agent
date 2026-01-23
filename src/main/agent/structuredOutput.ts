// ============================================================================
// Structured Output - Adaptive output mode for AI agent
// ============================================================================
//
// Intelligent output mode switching:
// - For humans: Natural language responses
// - For machines/automation: Structured JSON Schema output
//
// Usage scenarios:
// | Scenario       | Mode          | Schema                           |
// |----------------|---------------|----------------------------------|
// | User dialogue  | Natural lang  | None                             |
// | self_evaluate  | Structured    | { score: number, issues: string[] } |
// | API integration| Structured    | Custom schema                    |
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('StructuredOutput');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * JSON Schema definition for structured output
 * Follows JSON Schema draft-07 specification
 */
export interface JsonSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  properties?: Record<string, JsonSchemaProperty>;
  items?: JsonSchemaProperty;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
  enum?: (string | number | boolean | null)[];
  default?: unknown;
}

export interface JsonSchemaProperty {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | string[];
  description?: string;
  properties?: Record<string, JsonSchemaProperty>;
  items?: JsonSchemaProperty;
  required?: string[];
  additionalProperties?: boolean;
  enum?: (string | number | boolean | null)[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/**
 * Structured output configuration
 */
export interface StructuredOutputConfig {
  /**
   * Whether to enable structured output mode
   * When true, the model will return JSON that conforms to the schema
   */
  enabled: boolean;

  /**
   * JSON Schema that the output must conform to
   */
  schema: JsonSchema;

  /**
   * Name for the schema (used by some providers)
   */
  name?: string;

  /**
   * Whether to strictly enforce the schema (some providers support strict mode)
   * Default: true
   */
  strict?: boolean;

  /**
   * Fallback behavior when parsing fails
   * - 'error': Throw an error (default)
   * - 'raw': Return raw content as-is
   * - 'retry': Retry with a prompt to fix the format
   */
  onParseError?: 'error' | 'raw' | 'retry';
}

/**
 * Result of parsing structured output
 */
export interface StructuredOutputResult<T = unknown> {
  success: boolean;
  data?: T;
  rawContent?: string;
  error?: string;
  validationErrors?: string[];
}

// ----------------------------------------------------------------------------
// Pre-built Schemas
// ----------------------------------------------------------------------------

/**
 * Pre-built schema for self_evaluate tool output
 */
export const SELF_EVALUATE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    score: {
      type: 'number',
      description: 'Quality score from 0 to 100',
      minimum: 0,
      maximum: 100,
    },
    issues: {
      type: 'array',
      description: 'List of identified issues or improvements',
      items: {
        type: 'string',
      },
    },
    suggestions: {
      type: 'array',
      description: 'Suggestions for improvement',
      items: {
        type: 'string',
      },
    },
    summary: {
      type: 'string',
      description: 'Brief summary of the evaluation',
    },
  },
  required: ['score', 'issues'],
  additionalProperties: false,
};

/**
 * Pre-built schema for code review output
 */
export const CODE_REVIEW_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    overallQuality: {
      type: 'string',
      enum: ['excellent', 'good', 'fair', 'poor'],
      description: 'Overall code quality assessment',
    },
    issues: {
      type: 'array',
      description: 'List of code issues found',
      items: {
        type: 'object',
        properties: {
          severity: {
            type: 'string',
            enum: ['critical', 'major', 'minor', 'info'],
          },
          line: {
            type: 'number',
            description: 'Line number where issue was found',
          },
          message: {
            type: 'string',
            description: 'Description of the issue',
          },
          suggestion: {
            type: 'string',
            description: 'Suggested fix',
          },
        },
        required: ['severity', 'message'],
      },
    },
    metrics: {
      type: 'object',
      properties: {
        complexity: {
          type: 'number',
          description: 'Estimated cyclomatic complexity',
        },
        maintainability: {
          type: 'number',
          description: 'Maintainability score (0-100)',
        },
        testability: {
          type: 'number',
          description: 'Testability score (0-100)',
        },
      },
    },
  },
  required: ['overallQuality', 'issues'],
  additionalProperties: false,
};

/**
 * Pre-built schema for task planning output
 */
export const TASK_PLAN_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      description: 'List of tasks to complete',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Unique task identifier',
          },
          title: {
            type: 'string',
            description: 'Brief task title',
          },
          description: {
            type: 'string',
            description: 'Detailed task description',
          },
          dependencies: {
            type: 'array',
            description: 'IDs of tasks this depends on',
            items: {
              type: 'string',
            },
          },
          estimatedEffort: {
            type: 'string',
            enum: ['trivial', 'small', 'medium', 'large'],
          },
        },
        required: ['id', 'title'],
      },
    },
    summary: {
      type: 'string',
      description: 'Summary of the plan',
    },
    estimatedTotalTime: {
      type: 'string',
      description: 'Estimated total time to complete',
    },
  },
  required: ['tasks'],
  additionalProperties: false,
};

// ----------------------------------------------------------------------------
// Core Functions
// ----------------------------------------------------------------------------

/**
 * Parse and validate structured output from model response
 *
 * @param content - Raw content from model response
 * @param config - Structured output configuration
 * @returns Parsed and validated result
 */
export function parseStructuredOutput<T = unknown>(
  content: string,
  config: StructuredOutputConfig
): StructuredOutputResult<T> {
  if (!config.enabled || !content) {
    return {
      success: false,
      rawContent: content,
      error: 'Structured output not enabled or content is empty',
    };
  }

  // Try to extract JSON from the content
  const jsonContent = extractJson(content);

  if (!jsonContent) {
    logger.warn('[StructuredOutput] Failed to extract JSON from content');
    return handleParseError(content, 'Failed to extract JSON from response', config);
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContent);
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Unknown parse error';
    logger.warn('[StructuredOutput] JSON parse error:', error);
    return handleParseError(content, `JSON parse error: ${error}`, config);
  }

  // Validate against schema
  const validationResult = validateAgainstSchema(parsed, config.schema);

  if (!validationResult.valid) {
    logger.warn('[StructuredOutput] Schema validation failed:', validationResult.errors);
    return handleParseError(
      content,
      'Schema validation failed',
      config,
      validationResult.errors
    );
  }

  logger.debug('[StructuredOutput] Successfully parsed structured output');
  return {
    success: true,
    data: parsed as T,
    rawContent: content,
  };
}

/**
 * Create a structured output config from a JSON schema
 */
export function createStructuredOutputConfig(
  schema: JsonSchema,
  options?: Partial<Omit<StructuredOutputConfig, 'schema' | 'enabled'>>
): StructuredOutputConfig {
  return {
    enabled: true,
    schema,
    strict: true,
    onParseError: 'error',
    ...options,
  };
}

/**
 * Convert StructuredOutputConfig to OpenAI response_format parameter
 */
export function toOpenAIResponseFormat(config: StructuredOutputConfig): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: config.name || 'structured_output',
      strict: config.strict ?? true,
      schema: config.schema,
    },
  };
}

/**
 * Convert StructuredOutputConfig to Anthropic response format
 * Note: Anthropic uses tool_use with a specific schema for structured output
 */
export function toAnthropicResponseFormat(config: StructuredOutputConfig): Record<string, unknown> {
  return {
    tools: [
      {
        name: config.name || 'structured_response',
        description: 'Generate a structured response according to the schema',
        input_schema: config.schema,
      },
    ],
    tool_choice: {
      type: 'tool',
      name: config.name || 'structured_response',
    },
  };
}

// ----------------------------------------------------------------------------
// Helper Functions
// ----------------------------------------------------------------------------

/**
 * Extract JSON from content that may contain markdown code blocks or other text
 */
function extractJson(content: string): string | null {
  // Try direct parse first
  const trimmed = content.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return trimmed;
  }

  // Try to extract from markdown code block
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Try to find JSON object in content
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return jsonMatch[0];
  }

  // Try to find JSON array in content
  const arrayMatch = content.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    return arrayMatch[0];
  }

  return null;
}

/**
 * Validate data against a JSON schema
 * This is a simplified validator - for production, consider using ajv
 */
function validateAgainstSchema(
  data: unknown,
  schema: JsonSchema
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Type check
  const actualType = getJsonType(data);
  if (actualType !== schema.type) {
    errors.push(`Expected type '${schema.type}', got '${actualType}'`);
    return { valid: false, errors };
  }

  // Object validation
  if (schema.type === 'object' && typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;

    // Check required properties
    if (schema.required) {
      for (const requiredProp of schema.required) {
        if (!(requiredProp in obj)) {
          errors.push(`Missing required property: ${requiredProp}`);
        }
      }
    }

    // Check additional properties
    if (schema.additionalProperties === false && schema.properties) {
      const allowedProps = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(obj)) {
        if (!allowedProps.has(key)) {
          errors.push(`Unexpected property: ${key}`);
        }
      }
    }

    // Validate each property
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          const propResult = validateProperty(obj[key], propSchema, key);
          errors.push(...propResult.errors);
        }
      }
    }
  }

  // Array validation
  if (schema.type === 'array' && Array.isArray(data) && schema.items) {
    for (let i = 0; i < data.length; i++) {
      const itemResult = validateProperty(data[i], schema.items, `[${i}]`);
      errors.push(...itemResult.errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a single property value
 */
function validateProperty(
  value: unknown,
  schema: JsonSchemaProperty,
  path: string
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Handle union types
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actualType = getJsonType(value);

  if (!types.includes(actualType) && !types.includes('null')) {
    errors.push(`${path}: Expected type '${types.join(' | ')}', got '${actualType}'`);
    return { valid: false, errors };
  }

  // Enum validation
  if (schema.enum && !schema.enum.includes(value as string | number | boolean | null)) {
    errors.push(`${path}: Value must be one of: ${schema.enum.join(', ')}`);
  }

  // Number range validation
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: Value must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: Value must be <= ${schema.maximum}`);
    }
  }

  // String length validation
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: String length must be >= ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: String length must be <= ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: String must match pattern: ${schema.pattern}`);
    }
  }

  // Nested object validation
  if (schema.type === 'object' && typeof value === 'object' && value !== null && schema.properties) {
    const obj = value as Record<string, unknown>;
    if (schema.required) {
      for (const requiredProp of schema.required) {
        if (!(requiredProp in obj)) {
          errors.push(`${path}.${requiredProp}: Missing required property`);
        }
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in obj) {
        const propResult = validateProperty(obj[key], propSchema, `${path}.${key}`);
        errors.push(...propResult.errors);
      }
    }
  }

  // Array items validation
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const itemResult = validateProperty(value[i], schema.items, `${path}[${i}]`);
      errors.push(...itemResult.errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Get the JSON type of a value
 */
function getJsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Handle parse error according to config
 */
function handleParseError<T>(
  content: string,
  error: string,
  config: StructuredOutputConfig,
  validationErrors?: string[]
): StructuredOutputResult<T> {
  const onError = config.onParseError || 'error';

  switch (onError) {
    case 'raw':
      return {
        success: false,
        rawContent: content,
        error,
        validationErrors,
      };

    case 'retry':
      // For retry, return a special result that the caller can use to retry
      return {
        success: false,
        rawContent: content,
        error: `${error}. Consider retrying with format correction.`,
        validationErrors,
      };

    case 'error':
    default:
      return {
        success: false,
        rawContent: content,
        error,
        validationErrors,
      };
  }
}

/**
 * Generate a format correction prompt for retry
 */
export function generateFormatCorrectionPrompt(
  originalContent: string,
  schema: JsonSchema,
  errors: string[]
): string {
  return `The previous response did not conform to the required JSON schema.

Errors:
${errors.map((e) => `- ${e}`).join('\n')}

Required schema:
\`\`\`json
${JSON.stringify(schema, null, 2)}
\`\`\`

Your previous response:
\`\`\`
${originalContent.slice(0, 500)}${originalContent.length > 500 ? '...' : ''}
\`\`\`

Please provide a corrected response that strictly follows the JSON schema. Output ONLY valid JSON, no explanations.`;
}
