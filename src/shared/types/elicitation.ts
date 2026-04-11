// ============================================================================
// MCP Elicitation Types - Server-to-client user input requests
// ============================================================================

/**
 * MCP Elicitation 表单字段定义（仅原始类型，无嵌套）
 */
export interface ElicitationFieldSchema {
  type: 'string' | 'number' | 'integer' | 'boolean';
  title?: string;
  description?: string;
  default?: string | number | boolean;
  // string 特有
  enum?: string[];
  enumNames?: string[];
  minLength?: number;
  maxLength?: number;
  format?: 'email' | 'uri' | 'date' | 'date-time';
  // number/integer 特有
  minimum?: number;
  maximum?: number;
}

/**
 * 发送到前端的 Elicitation 请求
 */
export interface MCPElicitationRequest {
  id: string;
  serverName: string;
  message: string;
  fields: Record<string, ElicitationFieldSchema>;
  required?: string[];
  timestamp: number;
}

/**
 * 前端返回的 Elicitation 响应
 */
export interface MCPElicitationResponse {
  requestId: string;
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, string | number | boolean | string[]>;
}
