interface McpRecoverySource {
  id?: string;
  label?: string;
  error?: string;
  blockedReason?: {
    code?: string;
    detail?: string;
    hint?: string;
  };
}

const MCP_AUTH_FAILURE_PATTERNS = [
  /invalid[_\s-]?token/i,
  /authentication failed/i,
  /authorization failed/i,
  /unauthori[sz]ed/i,
  /\b401\b/,
  /bearer token/i,
  /access token.*(?:expired|invalid|revoked|unrecognized)/i,
  /token.*(?:expired|invalid|revoked|unrecognized|no longer recognized)/i,
  /oauth.*(?:expired|invalid|revoked|unrecognized|reauthori[sz]e)/i,
  /no longer recognized/i,
];

function stringifyRecoverySource(source: unknown): string {
  if (!source) {
    return '';
  }

  if (typeof source === 'string') {
    return source;
  }

  if (source instanceof Error) {
    return [source.name, source.message, source.stack].filter(Boolean).join('\n');
  }

  try {
    return JSON.stringify(source);
  } catch {
    return String(source);
  }
}

export function isMcpAuthenticationFailure(...sources: unknown[]): boolean {
  const text = sources.map(stringifyRecoverySource).join('\n');
  return MCP_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

export function isTavilyMcpServer(source: Pick<McpRecoverySource, 'id' | 'label'>): boolean {
  return /\btavily\b/i.test([source.id, source.label].filter(Boolean).join(' '));
}

export function getMcpAuthenticationRecoveryMessage(source: McpRecoverySource): string {
  const name = source.label || source.id || '这个 MCP';

  if (isTavilyMcpServer(source)) {
    return `${name} 的 MCP 授权已失效。请重新授权 Tavily MCP，或先禁用这个 MCP；禁用后内置搜索仍会使用共享搜索 key。`;
  }

  return `${name} 的 MCP 授权已失效。请重新授权这个 MCP，或先禁用它；禁用后它不会进入本轮工具范围。`;
}

export function getMcpAuthenticationRecoveryShortHint(source: McpRecoverySource): string {
  if (isTavilyMcpServer(source)) {
    return '需要重新授权；禁用 MCP 后内置搜索仍可用。';
  }

  return '需要重新授权；也可以先禁用这个 MCP。';
}
