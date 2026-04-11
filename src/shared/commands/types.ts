// ============================================================================
// Command Registry Types - 统一命令定义
// ============================================================================

export type CommandSurface = 'cli' | 'gui';
export type CommandCategory = 'session' | 'model' | 'context' | 'tools' | 'status' | 'system';

export interface CommandArgDef {
  name: string;
  description: string;
  required?: boolean;
}

export interface CommandOutput {
  info(msg: string): void;
  success(msg: string): void;
  error(msg: string): void;
  warn(msg: string): void;
}

export interface CommandContext {
  surface: CommandSurface;
  output: CommandOutput;
  // Surface-specific deps injected at call site
  [key: string]: unknown;
}

export interface CommandResult {
  success: boolean;
  message?: string;
  data?: unknown;
}

export interface CommandDefinition {
  id: string;
  name: string;
  description: string;
  category: CommandCategory;
  surfaces: CommandSurface[];
  aliases?: string[];
  args?: CommandArgDef[];
  handler: (ctx: CommandContext, args: string[]) => Promise<CommandResult>;
}
