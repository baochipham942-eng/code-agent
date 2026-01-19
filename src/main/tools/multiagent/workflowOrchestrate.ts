// ============================================================================
// Workflow Orchestrate Tool - Orchestrate multi-agent workflows
// Gen 7: Multi-Agent capability
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';
import type { ModelConfig } from '../../../shared/types';
import { getSubagentExecutor } from '../../agent/SubagentExecutor';
import { getAvailableRoles } from './spawnAgent';

// Predefined workflow templates
const WORKFLOW_TEMPLATES: Record<string, WorkflowTemplate> = {
  'code-review-pipeline': {
    name: 'Code Review Pipeline',
    description: 'Coder -> Reviewer -> Tester flow for feature development',
    stages: [
      {
        name: 'Development',
        role: 'coder',
        prompt: 'Implement the feature as specified.',
      },
      {
        name: 'Review',
        role: 'reviewer',
        prompt: 'Review the code written in the previous stage. List issues found.',
        dependsOn: ['Development'],
      },
      {
        name: 'Testing',
        role: 'tester',
        prompt: 'Write tests for the implemented feature.',
        dependsOn: ['Development'],
      },
    ],
  },
  'bug-fix-flow': {
    name: 'Bug Fix Flow',
    description: 'Debugger -> Coder -> Tester flow for bug fixes',
    stages: [
      {
        name: 'Investigation',
        role: 'debugger',
        prompt: 'Investigate the bug and identify the root cause.',
      },
      {
        name: 'Fix',
        role: 'coder',
        prompt: 'Implement the fix based on the investigation results.',
        dependsOn: ['Investigation'],
      },
      {
        name: 'Verification',
        role: 'tester',
        prompt: 'Write tests to verify the fix and prevent regression.',
        dependsOn: ['Fix'],
      },
    ],
  },
  'documentation-flow': {
    name: 'Documentation Flow',
    description: 'Architect -> Documenter flow for documentation',
    stages: [
      {
        name: 'Architecture Analysis',
        role: 'architect',
        prompt: 'Analyze the system architecture and key components.',
      },
      {
        name: 'Documentation',
        role: 'documenter',
        prompt: 'Write comprehensive documentation based on the architecture analysis.',
        dependsOn: ['Architecture Analysis'],
      },
    ],
  },
  'parallel-review': {
    name: 'Parallel Review',
    description: 'Run reviewer and tester in parallel',
    stages: [
      {
        name: 'Code Review',
        role: 'reviewer',
        prompt: 'Review the code for quality and issues.',
      },
      {
        name: 'Test Writing',
        role: 'tester',
        prompt: 'Write comprehensive tests.',
      },
    ],
  },
};

interface WorkflowStage {
  name: string;
  role: string;
  prompt: string;
  dependsOn?: string[];
}

interface WorkflowTemplate {
  name: string;
  description: string;
  stages: WorkflowStage[];
}

interface StageResult {
  stage: string;
  role: string;
  success: boolean;
  output: string;
  error?: string;
  duration: number;
}

export const workflowOrchestrateTool: Tool = {
  name: 'workflow_orchestrate',
  description: `Orchestrate multi-agent workflows for complex tasks.

Available workflow templates:
- code-review-pipeline: Coder -> Reviewer -> Tester
- bug-fix-flow: Debugger -> Coder -> Tester
- documentation-flow: Architect -> Documenter
- parallel-review: Reviewer + Tester in parallel

Use this tool to:
- Execute predefined workflow templates
- Define custom multi-stage workflows
- Coordinate multiple agents on a complex task

Parameters:
- workflow: Template name or 'custom'
- task: The overall task description
- stages: (for custom) Array of stage definitions
- parallel: (optional) Run independent stages in parallel`,
  generations: ['gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      workflow: {
        type: 'string',
        description: 'Workflow template name or "custom"',
      },
      task: {
        type: 'string',
        description: 'The task to accomplish',
      },
      stages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            role: { type: 'string' },
            prompt: { type: 'string' },
            dependsOn: { type: 'array', items: { type: 'string' } },
          },
          required: ['name', 'role', 'prompt'],
        },
        description: 'Custom workflow stages',
      },
      parallel: {
        type: 'boolean',
        description: 'Run independent stages in parallel',
      },
    },
    required: ['workflow', 'task'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const workflowName = params.workflow as string;
    const task = params.task as string;
    const customStages = params.stages as WorkflowStage[] | undefined;
    const parallel = params.parallel !== false;

    // Check for required context
    if (!context.toolRegistry || !context.modelConfig) {
      return {
        success: false,
        error: 'workflow_orchestrate requires toolRegistry and modelConfig in context',
      };
    }

    // Get workflow definition
    let workflow: WorkflowTemplate;
    if (workflowName === 'custom') {
      if (!customStages || customStages.length === 0) {
        return {
          success: false,
          error: 'Custom workflow requires stages array',
        };
      }
      workflow = {
        name: 'Custom Workflow',
        description: 'User-defined workflow',
        stages: customStages,
      };
    } else {
      workflow = WORKFLOW_TEMPLATES[workflowName];
      if (!workflow) {
        return {
          success: false,
          error: `Unknown workflow: ${workflowName}. Available: ${Object.keys(WORKFLOW_TEMPLATES).join(', ')}`,
        };
      }
    }

    const roles = getAvailableRoles();
    const results: StageResult[] = [];
    const stageOutputs: Map<string, string> = new Map();

    console.log(`[Workflow] Starting "${workflow.name}" with ${workflow.stages.length} stages`);

    try {
      // Build execution groups (stages with same dependencies can run in parallel)
      const executionGroups = buildExecutionGroups(workflow.stages);

      for (const group of executionGroups) {
        console.log(`[Workflow] Executing group: ${group.map(s => s.name).join(', ')}`);

        if (parallel && group.length > 1) {
          // Execute stages in parallel
          const groupResults = await Promise.all(
            group.map((stage) => executeStage(stage, task, stageOutputs, roles, context))
          );

          for (let i = 0; i < group.length; i++) {
            results.push(groupResults[i]);
            if (groupResults[i].success) {
              stageOutputs.set(group[i].name, groupResults[i].output);
            }
          }
        } else {
          // Execute stages sequentially
          for (const stage of group) {
            const result = await executeStage(stage, task, stageOutputs, roles, context);
            results.push(result);
            if (result.success) {
              stageOutputs.set(stage.name, result.output);
            }
          }
        }
      }

      // Build summary
      const successCount = results.filter(r => r.success).length;
      const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

      const stagesSummary = results.map((r) => {
        const icon = r.success ? '✅' : '❌';
        return `${icon} **${r.stage}** (${r.role}) - ${(r.duration / 1000).toFixed(1)}s
${r.success ? r.output.substring(0, 200) + (r.output.length > 200 ? '...' : '') : `Error: ${r.error}`}`;
      }).join('\n\n');

      return {
        success: successCount === results.length,
        output: `## Workflow: ${workflow.name}

**Task:** ${task}

**Summary:** ${successCount}/${results.length} stages completed
**Total Duration:** ${(totalDuration / 1000).toFixed(1)}s

---

### Stage Results:

${stagesSummary}`,
      };
    } catch (error) {
      return {
        success: false,
        error: `Workflow failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
};

// Build execution groups based on dependencies
function buildExecutionGroups(stages: WorkflowStage[]): WorkflowStage[][] {
  const groups: WorkflowStage[][] = [];
  const completed = new Set<string>();
  const remaining = [...stages];

  while (remaining.length > 0) {
    // Find stages whose dependencies are satisfied
    const ready = remaining.filter((stage) => {
      if (!stage.dependsOn || stage.dependsOn.length === 0) {
        return true;
      }
      return stage.dependsOn.every((dep) => completed.has(dep));
    });

    if (ready.length === 0) {
      // Circular dependency or invalid workflow
      throw new Error('Circular dependency or unsatisfied dependencies in workflow');
    }

    groups.push(ready);

    // Mark as completed and remove from remaining
    for (const stage of ready) {
      completed.add(stage.name);
      const idx = remaining.indexOf(stage);
      if (idx !== -1) {
        remaining.splice(idx, 1);
      }
    }
  }

  return groups;
}

// Execute a single stage
async function executeStage(
  stage: WorkflowStage,
  task: string,
  previousOutputs: Map<string, string>,
  roles: Record<string, { name: string; systemPrompt: string; tools: string[] }>,
  context: ToolContext
): Promise<StageResult> {
  const startTime = Date.now();

  const role = roles[stage.role];
  if (!role) {
    return {
      stage: stage.name,
      role: stage.role,
      success: false,
      output: '',
      error: `Unknown role: ${stage.role}`,
      duration: 0,
    };
  }

  // Build context from previous stages
  let contextFromPrevious = '';
  if (stage.dependsOn && stage.dependsOn.length > 0) {
    const previousResults = stage.dependsOn
      .map((dep) => {
        const output = previousOutputs.get(dep);
        return output ? `## ${dep} Output:\n${output}` : null;
      })
      .filter(Boolean)
      .join('\n\n');

    if (previousResults) {
      contextFromPrevious = `\n\n---\nContext from previous stages:\n${previousResults}`;
    }
  }

  const fullPrompt = `${stage.prompt}

Overall Task: ${task}${contextFromPrevious}`;

  try {
    const executor = getSubagentExecutor();
    const result = await executor.execute(
      fullPrompt,
      {
        name: `Stage:${stage.name}`,
        systemPrompt: role.systemPrompt,
        availableTools: role.tools,
        maxIterations: 15,
      },
      {
        modelConfig: context.modelConfig as ModelConfig,
        toolRegistry: new Map(
          context.toolRegistry!.getAllTools().map((t) => [t.name, t])
        ),
        toolContext: context,
      }
    );

    return {
      stage: stage.name,
      role: stage.role,
      success: result.success,
      output: result.output,
      error: result.error,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      stage: stage.name,
      role: stage.role,
      success: false,
      output: '',
      error: error instanceof Error ? error.message : 'Unknown error',
      duration: Date.now() - startTime,
    };
  }
}

// Export function to list available workflows
export function getAvailableWorkflows(): Record<string, WorkflowTemplate> {
  return { ...WORKFLOW_TEMPLATES };
}
