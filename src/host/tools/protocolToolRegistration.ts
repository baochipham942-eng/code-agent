import type { ToolHandler, ToolLoader, ToolSchema } from '../protocol/tools';
import type { ToolStepLabelKey } from '@shared/contract';

type ProtocolToolRegistryPort = {
  register(schema: ToolSchema, loader: ToolLoader): void;
  unregister(name: string): boolean;
  has(name: string): boolean;
  getSchemas(): readonly ToolSchema[];
  resolve(name: string): Promise<ToolHandler>;
};

let registryPort: ProtocolToolRegistryPort | null = null;

export function setProtocolToolRegistryPort(port: ProtocolToolRegistryPort): void {
  registryPort = port;
}

export function registerProtocolTool(schema: ToolSchema, loader: ToolLoader): void {
  if (!registryPort) {
    throw new Error('Protocol tool registry is not initialized');
  }
  registryPort.register(schema, loader);
}

export function unregisterProtocolTool(name: string): boolean {
  return registryPort?.unregister(name) ?? false;
}

export function hasProtocolTool(name: string): boolean {
  return registryPort?.has(name) ?? false;
}

export function getProtocolToolSchemas(): readonly ToolSchema[] {
  return registryPort?.getSchemas() ?? [];
}

export function resolveProtocolToolStepLabel(
  name: string,
  args: Record<string, unknown>,
): ToolStepLabelKey | undefined {
  const declaration = registryPort?.getSchemas().find((schema) => schema.name === name)?.stepLabel;
  if (!declaration) return undefined;
  const variantValue = declaration.variant
    ? args[declaration.variant.argument]
    : undefined;
  if (typeof variantValue === 'string') {
    return declaration.variant?.values[variantValue] ?? declaration.default;
  }
  return declaration.default;
}

export function resolveProtocolTool(name: string): Promise<ToolHandler> {
  if (!registryPort) {
    return Promise.reject(new Error('Protocol tool registry is not initialized'));
  }
  return registryPort.resolve(name);
}
