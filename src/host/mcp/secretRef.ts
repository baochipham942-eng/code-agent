import { MCP_SECRET_REF_PREFIX } from '../../shared/constants';

export const SECRET_REF_PREFIX = MCP_SECRET_REF_PREFIX;

export interface SecretReference {
  integrationId: string;
  field: string;
}

export interface ExtractedSecrets {
  sanitized: Record<string, string>;
  extracted: Record<string, string>;
}

/** 解析 MCP SecureStorage 凭据引用；普通字符串返回 null。 */
export function parseSecretRef(value: string): SecretReference | null {
  if (!value.startsWith(SECRET_REF_PREFIX)) {
    return null;
  }

  const reference = value.slice(SECRET_REF_PREFIX.length);
  const parts = reference.split('.');
  if (
    parts.length !== 2
    || !parts[0]
    || !parts[1]
    || parts.some((part) => part.includes(':'))
  ) {
    return null;
  }

  return {
    integrationId: parts[0],
    field: parts[1],
  };
}

/** 生成无歧义的 MCP SecureStorage 凭据引用。 */
export function encodeSecretRef(integrationId: string, field: string): string {
  if (!integrationId || !field || /[.:]/.test(integrationId) || /[.:]/.test(field)) {
    throw new Error('Secret reference integrationId and field must be non-empty and cannot contain "." or ":"');
  }
  return `${SECRET_REF_PREFIX}${integrationId}.${field}`;
}

/**
 * 从配置 map 中抽取指定敏感字段，并把原位置替换为 SecureStorage 引用。
 */
export function extractSecrets(
  values: Record<string, string>,
  secretKeys: string[],
  integrationId: string,
): ExtractedSecrets {
  const keys = new Set(secretKeys);
  const extracted: Record<string, string> = {};
  let sanitized = values;

  for (const [key, value] of Object.entries(values)) {
    if (!keys.has(key)) {
      continue;
    }
    if (sanitized === values) {
      sanitized = { ...values };
    }
    extracted[key] = value;
    sanitized[key] = encodeSecretRef(integrationId, key);
  }

  return { sanitized, extracted };
}

/**
 * 解引用 env/headers map。任何引用缺失都 fail-closed，且错误不携带真值。
 */
export function resolveSecretRefs(
  values: Record<string, string>,
  lookup: (integrationId: string) => Record<string, string> | null,
): Record<string, string> {
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(values)) {
    const reference = parseSecretRef(value);
    if (!reference) {
      resolved[key] = value;
      continue;
    }

    const integration = lookup(reference.integrationId);
    if (!integration) {
      throw new Error(
        `MCP credential "${reference.integrationId}.${reference.field}" is missing; please re-enter it in Connectors`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(integration, reference.field)) {
      throw new Error(
        `MCP credential field "${reference.integrationId}.${reference.field}" is missing; please re-enter it in Connectors`,
      );
    }

    resolved[key] = integration[reference.field];
  }

  return resolved;
}
