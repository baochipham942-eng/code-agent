// ============================================================================
// MCP 凭据键名判定 — renderer（MCP Server 编辑器）与 host（mcp_add_server 工具）
// 共用同一份"哪些 env/header 键是凭据"判定逻辑，避免两套定义各判各的（ADR-050/051）。
// ============================================================================

const SENSITIVE_MCP_KEY_PATTERN =
  /(api[-_]?key|authorization|bearer|token|secret|password|passwd|credential|private[-_]?key)/i;

/**
 * MCP env/header 键名是否是应抽进 SecureStorage 的凭据。
 * *_MODE 保存的是认证方式等配置枚举（如 LARK_TOKEN_MODE），不是凭据，需排除。
 */
export function isSensitiveMcpCredentialKey(key: string): boolean {
  const normalizedKey = key.trim();
  return !/_MODE$/i.test(normalizedKey) && SENSITIVE_MCP_KEY_PATTERN.test(normalizedKey);
}
