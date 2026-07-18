import type { IPCResponse } from './domains';

/**
 * 创建错误响应
 */
export function createErrorResponse(code: string, message: string, details?: unknown): IPCResponse<never> {
  return {
    success: false,
    error: {
      code,
      message,
      details,
    },
  };
}
