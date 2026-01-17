// ============================================================================
// Findings Write Tool - Save research findings and notes
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';
import type { PlanningService, FindingCategory } from '../../planning';

// Valid categories
const VALID_CATEGORIES: FindingCategory[] = [
  'code',
  'architecture',
  'dependency',
  'issue',
  'insight',
];

export const findingsWriteTool: Tool = {
  name: 'findings_write',
  description:
    'Save important findings and research notes to findings.md. ' +
    'Use this to persist discoveries that should not be lost. ' +
    'Helps maintain knowledge across long sessions and prevents context overflow.',
  generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: VALID_CATEGORIES,
        description:
          'Category of the finding: code (code insights), architecture (design patterns), ' +
          'dependency (library/package info), issue (problems found), insight (general observations)',
      },
      title: {
        type: 'string',
        description: 'Brief title for the finding (1-2 sentences)',
      },
      content: {
        type: 'string',
        description: 'Detailed content of the finding',
      },
      source: {
        type: 'string',
        description: 'Source file path or URL where this was discovered (optional)',
      },
    },
    required: ['category', 'title', 'content'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const category = params.category as FindingCategory;
    const title = params.title as string;
    const content = params.content as string;
    const source = params.source as string | undefined;

    // Validate category
    if (!VALID_CATEGORIES.includes(category)) {
      return {
        success: false,
        error: `Invalid category: ${category}. Must be one of: ${VALID_CATEGORIES.join(', ')}`,
      };
    }

    // Validate required fields
    if (!title || title.trim().length === 0) {
      return {
        success: false,
        error: 'title is required and cannot be empty',
      };
    }

    if (!content || content.trim().length === 0) {
      return {
        success: false,
        error: 'content is required and cannot be empty',
      };
    }

    const planningService = context.planningService as PlanningService | undefined;

    if (!planningService) {
      return {
        success: false,
        error:
          'Planning service not available. Cannot save findings. ' +
          'Make sure planning is enabled in the agent configuration.',
      };
    }

    try {
      // Initialize planning service if needed
      await planningService.initialize();

      // Add the finding
      const finding = await planningService.findings.add({
        category,
        title: title.trim(),
        content: content.trim(),
        source,
      });

      // Get total count
      const totalCount = await planningService.findings.getCount();

      return {
        success: true,
        output:
          `Finding saved to findings.md:\n\n` +
          `**Category:** ${category}\n` +
          `**Title:** ${title}\n` +
          `**ID:** ${finding.id}\n\n` +
          `Total findings: ${totalCount}`,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to save finding: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      };
    }
  },
};
