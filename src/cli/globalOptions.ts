// ============================================================================
// CLI Global Options — 根命令全局旗标注册（单一真源）
// ============================================================================
// 从 index.ts 抽出：run/chat 等子命令经 command.parent.opts() 继承这批选项，
// 测试也要对这份清单断言（--bare 等），注册逻辑只此一处。
// ============================================================================

import type { Command } from 'commander';

/** 注册 neo 根命令的全局选项。返回同一 program 实例便于链式调用。 */
export function registerCLIGlobalOptions(program: Command): Command {
  return program
    .option('-p, --project <path>', '项目目录', process.cwd())
    .option('--json', 'JSON 格式输出')
    .option('--model <name>', '模型名称')
    .option('--provider <name>', '模型提供商 (deepseek, openai, zhipu)')
    .option('--plan', '启用规划模式（复杂任务自动分解）')
    .option('--debug', '调试模式')
    .option('--output-format <format>', '输出格式 (text|json|stream-json)', 'text')
    .option('--system-prompt <prompt>', '自定义系统提示')
    .option('--metrics <path>', '会话结束后写入指标 JSON（用于 eval 分析）')
    .option('--bare', 'skip host-local hooks/skills/MCP; product built-in skills stay');
}
