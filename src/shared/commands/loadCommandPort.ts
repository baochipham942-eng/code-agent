// ============================================================================
// 从 CommandContext 取出 CLI/GUI 注入的端口模块。
// 缺端口抛出的错误由各命令 handler 自己接住，不把 host 模块拉进 shared。
// ============================================================================

export async function loadCommandPort<T extends object>(
  ctx: Record<string, unknown>,
  key: string,
): Promise<T> {
  const load = ctx[key];
  if (typeof load !== 'function') {
    throw new Error(`${key} port is not available`);
  }
  const loaded: unknown = await (load as () => Promise<unknown>)();
  if (!loaded || typeof loaded !== 'object') {
    throw new Error(`${key} port is not available`);
  }
  return loaded as T;
}
