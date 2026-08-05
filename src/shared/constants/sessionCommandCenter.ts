/** Tools exposed to the foreground text brain. Background task runs deny them. */
export const SESSION_COMMAND_CENTER_TOOL_NAMES = [
  'spawn_task',
  'steer_task',
  'cancel_task',
  'task_status',
] as const;

export const SESSION_COMMAND_CENTER_BRAIN_TOOL_NAMES = [
  ...SESSION_COMMAND_CENTER_TOOL_NAMES,
  'AskUserQuestion',
] as const;

/** Foreground brain should route or answer without growing into an execution run. */
export const SESSION_COMMAND_CENTER_BRAIN_MAX_ITERATIONS = 8;
