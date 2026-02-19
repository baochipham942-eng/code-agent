// ============================================================================
// Managed Configuration Types - Enterprise administration
// ============================================================================
// These types define the interface for enterprise/managed deployments.
// Implementation is deferred; this serves as an architectural placeholder.
// ============================================================================

export interface ManagedPolicy {
  id: string;
  name: string;
  rules: ManagedPolicyRule[];
  enforcementLevel: 'strict' | 'advisory';
}

export interface ManagedPolicyRule {
  type: 'allow_tool' | 'deny_tool' | 'require_approval' | 'model_restriction';
  target: string;
  conditions?: Record<string, unknown>;
}

export interface ManagedConfig {
  organizationId: string;
  organizationName?: string;

  // Policy enforcement
  managedPolicies: ManagedPolicy[];

  // Model restrictions
  allowedProviders?: string[];
  allowedModels?: string[];
  defaultModel?: string;

  // Feature gates
  features?: {
    allowCustomAgents?: boolean;
    allowMcpServers?: boolean;
    allowNetworkAccess?: boolean;
    allowShellExecution?: boolean;
  };

  // Telemetry
  telemetry?: {
    enabled: boolean;
    endpoint?: string;
    includePrompts?: boolean;
  };

  // Version and update
  version: string;
  lastUpdated: number;
}
