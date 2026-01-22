# Security Module API Reference

> **Status**: SCAFFOLD - Will be completed when Session A finishes A1-A5

This document describes the security module APIs for Code Agent.

## Overview

The security module provides runtime security monitoring, sensitive information detection, and audit logging.

## Modules

### Command Monitor (`src/main/security/commandMonitor.ts`)

Monitors bash command execution for security concerns.

```typescript
// TODO: Document when A1 is complete
interface CommandMonitor {
  preExecute(command: string): Promise<ValidationResult>;
  monitor(pid: number): void;
  postExecute(result: ExecutionResult): Promise<void>;
}

interface ValidationResult {
  allowed: boolean;
  reason?: string;
  securityFlags?: string[];
}
```

#### Methods

##### `preExecute(command: string): Promise<ValidationResult>`

Validates a command before execution.

**Parameters:**
- `command` - The shell command to validate

**Returns:**
- `ValidationResult` with `allowed` boolean and optional `reason`

**Example:**
```typescript
// TODO: Add example when implemented
const result = await commandMonitor.preExecute('rm -rf node_modules');
if (!result.allowed) {
  console.log('Blocked:', result.reason);
}
```

##### `postExecute(result: ExecutionResult): Promise<void>`

Records execution result for audit logging.

---

### Sensitive Detector (`src/main/security/sensitiveDetector.ts`)

Detects sensitive information patterns in text content.

```typescript
// TODO: Document when A2 is complete
interface SensitiveDetector {
  detect(text: string): SensitiveMatch[];
  mask(text: string): string;
}

interface SensitiveMatch {
  type: SensitiveType;
  start: number;
  end: number;
  masked: string;
}

type SensitiveType =
  | 'apiKey'
  | 'awsSecret'
  | 'awsAccessKey'
  | 'githubToken'
  | 'privateKey'
  | 'password'
  | 'databaseUrl'
  | 'jwtToken'
  | 'oauth'
  | 'basicAuth';
```

#### Supported Patterns

| Type | Pattern Description | Example |
|------|---------------------|---------|
| `apiKey` | Generic API keys | `api_key=sk-123...` |
| `awsSecret` | AWS Secret Access Key | 40-char base64 |
| `awsAccessKey` | AWS Access Key ID | `AKIA...` |
| `githubToken` | GitHub Personal Access Token | `ghp_...` |
| `privateKey` | SSH/PGP private keys | `-----BEGIN ... PRIVATE KEY-----` |
| `password` | Password patterns in URLs/configs | `password=...` |
| `databaseUrl` | Database connection strings | `postgres://user:pass@...` |

---

### Audit Logger (`src/main/security/auditLogger.ts`)

Records all tool executions to JSONL audit logs.

```typescript
// TODO: Document when A3 is complete
interface AuditLogger {
  log(entry: AuditEntry): Promise<void>;
  query(options: QueryOptions): Promise<AuditEntry[]>;
  getLogPath(date: Date): string;
}

interface AuditEntry {
  timestamp: number;
  eventType: 'tool_usage' | 'permission_check' | 'file_access' | 'security_incident';
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  output?: string;
  duration: number;
  success: boolean;
  securityFlags?: string[];
}

interface QueryOptions {
  startTime?: number;
  endTime?: number;
  sessionId?: string;
  eventType?: AuditEntry['eventType'];
  toolName?: string;
}
```

#### Log File Location

Logs are stored at `~/.code-agent/audit/YYYY-MM-DD.jsonl`

#### Example Log Entry

```json
{
  "timestamp": 1705968000000,
  "eventType": "tool_usage",
  "sessionId": "sess_abc123",
  "toolName": "bash",
  "input": { "command": "git status" },
  "output": "On branch main...",
  "duration": 150,
  "success": true
}
```

---

### Log Masker (`src/main/security/logMasker.ts`)

Automatically masks sensitive information in log output.

```typescript
// TODO: Document when A5 is complete
interface LogMasker {
  mask(text: string): string;
  maskObject(obj: Record<string, unknown>): Record<string, unknown>;
}
```

#### Masking Format

Sensitive values are replaced with `***REDACTED***`.

**Example:**
```typescript
const masked = logMasker.mask('api_key=sk-secret123');
// Result: 'api_key=***REDACTED***'
```

---

## Integration

### Tool Executor Integration

The security module integrates with `toolExecutor.ts`:

```typescript
// Simplified integration flow
async function executeToolSecurely(tool: string, args: unknown) {
  // 1. Pre-execution validation
  if (tool === 'bash') {
    const validation = await commandMonitor.preExecute(args.command);
    if (!validation.allowed) {
      return { error: validation.reason };
    }
  }

  // 2. Execute tool
  const startTime = Date.now();
  const result = await executeTool(tool, args);
  const duration = Date.now() - startTime;

  // 3. Audit logging with masking
  await auditLogger.log({
    timestamp: startTime,
    eventType: 'tool_usage',
    toolName: tool,
    input: logMasker.maskObject(args),
    output: logMasker.mask(result.output),
    duration,
    success: result.success,
    securityFlags: result.securityFlags,
  });

  return result;
}
```

---

## Configuration

Security module configuration in `.claude/settings.json`:

```json
{
  "security": {
    "auditLog": {
      "enabled": true,
      "retentionDays": 30
    },
    "sensitiveDetection": {
      "enabled": true,
      "customPatterns": []
    },
    "commandMonitor": {
      "blockedPatterns": ["rm -rf /", ":(){ :|:& };:"],
      "warningPatterns": ["sudo", "chmod 777"]
    }
  }
}
```

---

## See Also

- [Security Test Scaffolds](../../tests/unit/security/)
- [E2E Security Tests](../../tests/e2e/security.test.ts)
