import type { ToolHandler, ToolLoader, ToolSchema } from '../protocol/tools';

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

export function resolveProtocolTool(name: string): Promise<ToolHandler> {
  if (!registryPort) {
    return Promise.reject(new Error('Protocol tool registry is not initialized'));
  }
  return registryPort.resolve(name);
}
