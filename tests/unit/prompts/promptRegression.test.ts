// ============================================================================
// Prompt Regression Tests
// ============================================================================
//
// Guards against stale tool-prompt wording drifting back into the runtime prompt.
// These tests intentionally focus on the prompt surfaces the model sees, not on
// legacy adapters that may still accept old tool names for transcript compatibility.
// ============================================================================

import { readdirSync, readFileSync, statSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { buildPrompt, buildDynamicPromptV2 } from '../../../src/main/prompts/builder';
import { injectWorkingDirectoryContext } from '../../../src/main/agent/messageHandling/contextBuilder';

const repoRoot = process.cwd();

function collectPromptSurfaceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...collectPromptSurfaceFiles(path));
    } else if (entry.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

describe('prompt regressions', () => {
  it('does not expose stale Edit parameters in the base system prompt', () => {
    const prompt = buildPrompt();

    expect(prompt).toContain('old_text');
    expect(prompt).toContain('new_text');
    expect(prompt).toContain('edits');
    expect(prompt).not.toContain('old_string');
    expect(prompt).not.toContain('new_string');
  });

  it('does not nudge the model to commit after ordinary file edits', () => {
    const prompt = buildPrompt();
    const result = buildDynamicPromptV2('Fix the failing unit test', {
      toolsUsedInTurn: ['Edit'],
      includeFewShot: false,
    });
    const combined = `${prompt}\n${result.userMessage}`;

    expect(combined).not.toContain('记得提交');
    expect(combined).not.toContain('git add . &&');
    expect(combined).toContain('只有用户明确要求 commit');
  });

  it('uses current canonical tool names on runtime prompt surfaces', () => {
    const prompt = buildPrompt();
    const withWorkingDirectory = injectWorkingDirectoryContext(prompt, repoRoot, true);

    expect(withWorkingDirectory).toContain('AskUserQuestion');
    expect(withWorkingDirectory).toContain('"questions"');
    expect(withWorkingDirectory).toContain('TaskManager');
    expect(withWorkingDirectory).toContain('ToolSearch');
    expect(withWorkingDirectory).not.toContain('ask_user_question');
    expect(withWorkingDirectory).not.toContain('task_create');
    expect(withWorkingDirectory).not.toContain('task_update');
    expect(withWorkingDirectory).not.toContain('CodeExecute');
  });

  it('documents deferred ToolSearch calls with schema-shaped JSON arguments', () => {
    const messageBuildSource = readFileSync(
      `${repoRoot}/src/main/agent/runtime/contextAssembly/messageBuild.ts`,
      'utf8',
    );

    expect(messageBuildSource).toContain('{"query":"browser"}');
    expect(messageBuildSource).toContain('{"query":"select:Browser"}');
    expect(messageBuildSource).not.toContain('ToolSearch("browser")');
    expect(messageBuildSource).not.toContain('ToolSearch("select:Browser")');
  });

  it('keeps shell guidance balanced instead of banning Bash for all file inspection', () => {
    const prompt = buildPrompt();

    expect(prompt).toContain('Prefer Read/Glob/Grep for ordinary file inspection');
    expect(prompt).toContain('use Bash for tests, builds, git, CLI workflows, diagnostics');
    expect(prompt).not.toContain('NEVER use Bash to read files');
    expect(prompt).not.toContain('no cat/grep/sed in shell');
  });

  it('does not ask the model to emit visible think tags', () => {
    const prompt = buildPrompt();

    expect(prompt).not.toContain('<think>');
    expect(prompt).not.toContain('</think>');
  });

  it('routes multi-dimensional subagent reminders to AgentSpawn instead of parallel Task examples', () => {
    const result = buildDynamicPromptV2('对项目做全面安全审计，检查认证授权、输入验证、数据安全和依赖安全', {
      includeFewShot: false,
      maxReminderTokens: 1000,
    });

    expect(result.userMessage).toContain('AgentSpawn');
    expect(result.userMessage).not.toContain('Task(subagent_type');
    expect(result.userMessage).not.toContain('并行派发多个 Task');
    expect(result.userMessage).not.toContain('多个 Task');
  });

  it('does not include the default SOUL template instructions in the runtime prompt', () => {
    const prompt = buildPrompt();

    expect(prompt).not.toContain('自定义提示：把你希望 Agent');
    expect(prompt).not.toContain('本文件只替换核心身份块');
  });

  it('keeps stale prompt tokens out of prompt source surfaces', () => {
    const files = [
      ...collectPromptSurfaceFiles(`${repoRoot}/src/main/prompts`),
      `${repoRoot}/src/main/agent/messageHandling/contextBuilder.ts`,
      `${repoRoot}/src/main/agent/runtime/contextAssembly/messageBuild.ts`,
    ];
    const combined = files
      .map((file) => `\n--- ${file} ---\n${readFileSync(file, 'utf8')}`)
      .join('\n');

    for (const staleToken of [
      'old_string',
      'new_string',
      'ToolSearch("',
      'task_create',
      'task_update',
      'ask_user_question',
      'read_file',
      'web_search',
      'web_fetch',
      'read_xlsx',
      'write_file',
      'edit_file',
      'exit_plan_mode',
      'enter_plan_mode',
      'Task(subagent_type',
      '并行派发多个 Task',
      'Task 工具也支持并行',
      'CodeExecute',
      '<think>',
    ]) {
      expect(combined).not.toContain(staleToken);
    }
  });
});
