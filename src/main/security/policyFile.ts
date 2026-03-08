// ============================================================================
// Policy File - Enterprise security policy definitions (TOML format)
// ============================================================================
//
// Policy file: code-agent-policy.toml
// Placed by admins in project root or ~/.code-agent/
// Developers cannot override admin policies.

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface NetworkPolicy {
  /** Whether network access is allowed */
  allow: boolean;
  /** Allowed domain whitelist (only effective when allow=true) */
  allowed_domains: string[];
}

export interface FilesystemPolicy {
  /** Writable path patterns (glob) */
  writable_paths: string[];
  /** Denied paths (higher priority than writable) */
  denied_paths: string[];
  /** Denied file patterns */
  denied_file_patterns: string[];
}

export interface ExecutionPolicy {
  /** Whether shell commands are allowed */
  allow_shell: boolean;
  /** Denied command patterns (regex) */
  denied_commands: string[];
  /** Allowed command prefixes */
  allowed_command_prefixes: string[];
}

export interface ToolsPolicy {
  /** Disabled tool names */
  disabled: string[];
  /** Tools that always require confirmation */
  always_confirm: string[];
}

export interface ModelPolicy {
  /** Allowed model providers */
  allowed_providers: string[];
  /** Providers restricted from receiving code */
  code_restricted_providers: string[];
}

export interface AuditPolicy {
  /** Whether to log all tool calls */
  log_all_tool_calls: boolean;
  /** Audit log file path */
  log_path: string;
}

export interface SecurityPolicy {
  network: NetworkPolicy;
  filesystem: FilesystemPolicy;
  execution: ExecutionPolicy;
  tools: ToolsPolicy;
  model: ModelPolicy;
  audit: AuditPolicy;
}

// ----------------------------------------------------------------------------
// Defaults
// ----------------------------------------------------------------------------

export function createDefaultPolicy(): SecurityPolicy {
  return {
    network: {
      allow: true,
      allowed_domains: [],
    },
    filesystem: {
      writable_paths: ['./**'],
      denied_paths: ['~/.ssh/**', '~/.aws/**', '/etc/**'],
      denied_file_patterns: ['*.pem', '*.key', 'id_rsa*'],
    },
    execution: {
      allow_shell: true,
      denied_commands: ['rm -rf /', 'curl.*\\|.*sh', 'wget.*\\|.*sh', 'sudo.*'],
      allowed_command_prefixes: [],
    },
    tools: {
      disabled: [],
      always_confirm: [],
    },
    model: {
      allowed_providers: [],
      code_restricted_providers: [],
    },
    audit: {
      log_all_tool_calls: false,
      log_path: '.code-agent/audit.log',
    },
  };
}

// ----------------------------------------------------------------------------
// Simple TOML Parser
// ----------------------------------------------------------------------------
//
// Supports: [section], key = value (string, boolean, string array)
// Does NOT support nested tables, inline tables, multiline arrays, etc.

export function parseSimpleToml(content: string): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  let currentSection = '';

  const lines = content.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) continue;

    // Section header: [section]
    const sectionMatch = line.match(/^\[([a-zA-Z_][a-zA-Z0-9_]*)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!result[currentSection]) {
        result[currentSection] = {};
      }
      continue;
    }

    // Key = value
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
    if (kvMatch && currentSection) {
      const key = kvMatch[1];
      const rawValue = kvMatch[2].trim();
      result[currentSection][key] = parseTomlValue(rawValue);
    }
  }

  return result;
}

function parseTomlValue(raw: string): unknown {
  // Boolean
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  // String array: ["a", "b", "c"]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];

    const items: string[] = [];
    // Parse comma-separated quoted strings
    const regex = /"([^"]*?)"|'([^']*?)'/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(inner)) !== null) {
      items.push(match[1] ?? match[2]);
    }
    return items;
  }

  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }

  // Number
  const num = Number(raw);
  if (!isNaN(num)) return num;

  // Fallback: raw string
  return raw;
}

// ----------------------------------------------------------------------------
// Policy from parsed TOML
// ----------------------------------------------------------------------------

export function policyFromToml(parsed: Record<string, Record<string, unknown>>): Partial<SecurityPolicy> {
  const policy: Partial<SecurityPolicy> = {};

  if (parsed.network) {
    policy.network = {
      allow: typeof parsed.network.allow === 'boolean' ? parsed.network.allow : true,
      allowed_domains: Array.isArray(parsed.network.allowed_domains)
        ? parsed.network.allowed_domains as string[]
        : [],
    };
  }

  if (parsed.filesystem) {
    policy.filesystem = {
      writable_paths: Array.isArray(parsed.filesystem.writable_paths)
        ? parsed.filesystem.writable_paths as string[]
        : ['./**'],
      denied_paths: Array.isArray(parsed.filesystem.denied_paths)
        ? parsed.filesystem.denied_paths as string[]
        : [],
      denied_file_patterns: Array.isArray(parsed.filesystem.denied_file_patterns)
        ? parsed.filesystem.denied_file_patterns as string[]
        : [],
    };
  }

  if (parsed.execution) {
    policy.execution = {
      allow_shell: typeof parsed.execution.allow_shell === 'boolean'
        ? parsed.execution.allow_shell : true,
      denied_commands: Array.isArray(parsed.execution.denied_commands)
        ? parsed.execution.denied_commands as string[]
        : [],
      allowed_command_prefixes: Array.isArray(parsed.execution.allowed_command_prefixes)
        ? parsed.execution.allowed_command_prefixes as string[]
        : [],
    };
  }

  if (parsed.tools) {
    policy.tools = {
      disabled: Array.isArray(parsed.tools.disabled)
        ? parsed.tools.disabled as string[]
        : [],
      always_confirm: Array.isArray(parsed.tools.always_confirm)
        ? parsed.tools.always_confirm as string[]
        : [],
    };
  }

  if (parsed.model) {
    policy.model = {
      allowed_providers: Array.isArray(parsed.model.allowed_providers)
        ? parsed.model.allowed_providers as string[]
        : [],
      code_restricted_providers: Array.isArray(parsed.model.code_restricted_providers)
        ? parsed.model.code_restricted_providers as string[]
        : [],
    };
  }

  if (parsed.audit) {
    policy.audit = {
      log_all_tool_calls: typeof parsed.audit.log_all_tool_calls === 'boolean'
        ? parsed.audit.log_all_tool_calls : false,
      log_path: typeof parsed.audit.log_path === 'string'
        ? parsed.audit.log_path : '.code-agent/audit.log',
    };
  }

  return policy;
}
