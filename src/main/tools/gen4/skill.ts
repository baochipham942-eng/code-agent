// ============================================================================
// Skill Tool - Execute predefined skills/workflows
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';
import type { SkillDefinition, ModelConfig } from '../../../shared/types';
import { getSubagentExecutor } from '../../agent/SubagentExecutor';

// Built-in skills
const BUILT_IN_SKILLS: Record<string, SkillDefinition> = {
  commit: {
    name: 'commit',
    description: 'Create a git commit following best practices',
    prompt: `You are a git commit assistant. Create a well-structured git commit:

1. First run 'git status' to see all changes
2. Run 'git diff --staged' to see staged changes (or 'git diff' for unstaged)
3. Analyze the changes and determine:
   - What type of change is this? (feat, fix, refactor, docs, style, test, chore)
   - What is the scope of the change?
   - What is the main purpose of the change?
4. Write a commit message following conventional commit format:
   - First line: type(scope): short description (max 72 chars)
   - Blank line
   - Body: explain WHY the change was made, not just WHAT changed
5. Stage files if needed with 'git add'
6. Create the commit with 'git commit -m "message"'

Important:
- Never skip pre-commit hooks (don't use --no-verify)
- Focus on WHY not WHAT in the commit message
- Keep the first line under 72 characters`,
    tools: ['bash', 'read_file'],
  },
  'code-review': {
    name: 'code-review',
    description: 'Review code for bugs, security issues, and best practices',
    prompt: `You are a code review assistant. Review the code changes thoroughly:

1. First understand what files have changed using 'git diff' or 'git status'
2. Read the changed files to understand the context
3. Look for:
   - Potential bugs and logic errors
   - Security vulnerabilities (injection, XSS, etc.)
   - Performance issues
   - Code style and readability
   - Missing error handling
   - Edge cases not handled
4. Check if tests are updated for the changes
5. Provide constructive feedback with specific line references

Format your review as:
## Summary
Brief overview of the changes

## Issues Found
### Critical
- Issue description and location

### Suggestions
- Improvement suggestions

## What Looks Good
- Positive aspects of the code`,
    tools: ['bash', 'read_file', 'glob', 'grep'],
  },
  test: {
    name: 'test',
    description: 'Run and analyze tests',
    prompt: `You are a test runner assistant. Run and analyze the test suite:

1. Identify the test framework by checking package.json or project files
2. Find test files using glob patterns (e.g., **/*.test.ts, **/*.spec.js)
3. Run the appropriate test command:
   - npm test, yarn test, pytest, go test, etc.
4. Analyze the output:
   - Count passed/failed/skipped tests
   - Identify failing tests and their error messages
   - Look for patterns in failures
5. For failing tests:
   - Read the test file to understand what's being tested
   - Read the source code being tested
   - Suggest potential fixes

Provide a summary:
## Test Results
- Total: X tests
- Passed: X
- Failed: X
- Skipped: X

## Failing Tests
[Details of each failure]

## Suggested Fixes
[Recommendations for fixing failures]`,
    tools: ['bash', 'read_file', 'glob'],
  },
  'feature-dev': {
    name: 'feature-dev',
    description: 'Guided feature development workflow',
    prompt: `You are a feature development assistant. Help develop a new feature:

1. **Understand Requirements**
   - Clarify what the feature should do
   - Identify acceptance criteria

2. **Explore the Codebase**
   - Find similar existing features for patterns
   - Identify where new code should be added
   - Understand the project structure

3. **Plan Implementation**
   - Break down into smaller tasks
   - Identify files to create/modify
   - Consider edge cases and error handling

4. **Implement**
   - Create necessary files
   - Follow existing code patterns
   - Add appropriate error handling

5. **Test**
   - Write tests for the new feature
   - Run existing tests to ensure no regressions

Always follow the project's existing patterns and conventions.`,
    tools: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'],
  },
};

export const skillTool: Tool = {
  name: 'skill',
  description: 'Execute a predefined skill or workflow. Available skills: commit, code-review, test, feature-dev',
  generations: ['gen4'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'The skill name to execute: commit, code-review, test, feature-dev',
        enum: Object.keys(BUILT_IN_SKILLS),
      },
      args: {
        type: 'string',
        description: 'Optional arguments or context for the skill',
      },
    },
    required: ['skill'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const skillName = params.skill as string;
    const args = params.args as string | undefined;

    const skill = BUILT_IN_SKILLS[skillName];
    if (!skill) {
      return {
        success: false,
        error: `Unknown skill: ${skillName}. Available skills: ${Object.keys(BUILT_IN_SKILLS).join(', ')}`,
      };
    }

    // Check if we have the required context for subagent execution
    if (!context.toolRegistry || !context.modelConfig) {
      // Fallback to returning skill info if context not available
      let prompt = skill.prompt;
      if (args) {
        prompt += `\n\nUser context: ${args}`;
      }

      return {
        success: true,
        output:
          `Skill: ${skill.name}\n` +
          `Description: ${skill.description}\n\n` +
          `Instructions:\n${prompt}\n\n` +
          `(Execute these steps manually - subagent context not available)`,
      };
    }

    // Build the prompt with user arguments
    let fullPrompt = skill.prompt;
    if (args) {
      fullPrompt += `\n\n---\nUser request: ${args}`;
    }

    console.log(`[Skill:${skillName}] Starting execution...`);

    try {
      const executor = getSubagentExecutor();
      const result = await executor.execute(
        fullPrompt,
        {
          name: `Skill:${skillName}`,
          systemPrompt: `You are executing the "${skill.name}" skill. ${skill.description}. Follow the instructions carefully and provide clear output.`,
          availableTools: skill.tools || [],
          maxIterations: 15,
        },
        {
          modelConfig: context.modelConfig as ModelConfig,
          toolRegistry: new Map(
            context.toolRegistry.getAllTools().map((t) => [t.name, t])
          ),
          toolContext: context,
        }
      );

      if (result.success) {
        return {
          success: true,
          output:
            `✅ Skill "${skill.name}" completed\n` +
            `Iterations: ${result.iterations}\n` +
            `Tools used: ${result.toolsUsed.join(', ') || 'none'}\n\n` +
            `Result:\n${result.output}`,
        };
      } else {
        return {
          success: false,
          error: `Skill "${skill.name}" failed: ${result.error}`,
          output: result.output,
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Skill execution error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
};

// Export function to get available skills
export function getAvailableSkills(): SkillDefinition[] {
  return Object.values(BUILT_IN_SKILLS);
}

// Export function to get skill by name
export function getSkill(name: string): SkillDefinition | undefined {
  return BUILT_IN_SKILLS[name];
}
