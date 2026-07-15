import { getMCPClient } from './mcpClient';
import { CUA_DRIVER_SERVER_NAME } from './types';
import type {
  CuaDriverCallContext,
  CuaDriverCallResult,
  CuaDriverPort,
} from './cuaStateAdapter';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class CuaMcpDriverPort implements CuaDriverPort {
  async call(
    toolName: string,
    args: Record<string, unknown>,
    context: CuaDriverCallContext,
  ): Promise<CuaDriverCallResult> {
    const result = await getMCPClient().callTool(
      `${context.toolCallId}:cua:${toolName}:${Date.now()}`,
      CUA_DRIVER_SERVER_NAME,
      toolName,
      args,
      {
        sessionId: context.sessionId,
        abortSignal: context.abortSignal,
        cuaStatefulFacade: true,
      },
    );
    const metadata = result.metadata ?? {};
    const rawStructured = metadata.mcpStructuredContent;
    const rawScreenshot = metadata.cuaScreenshot;
    const screenshot = isRecord(rawScreenshot)
      && typeof rawScreenshot.data === 'string'
      && typeof rawScreenshot.mimeType === 'string'
      ? { data: rawScreenshot.data, mimeType: rawScreenshot.mimeType }
      : undefined;
    return {
      success: result.success,
      output: result.output,
      error: result.error,
      ...(isRecord(rawStructured) ? { structured: rawStructured } : {}),
      ...(screenshot ? { screenshot } : {}),
      deliveryUnknown: metadata.cuaDeliveryUnknown === true,
    };
  }

  getGeneration(): string | undefined {
    return getMCPClient().getServerConnectionGeneration(CUA_DRIVER_SERVER_NAME);
  }
}
