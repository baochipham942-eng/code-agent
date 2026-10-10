// Fixed permission-decision table. Captured before the policy-hash audit change.
// evaluate() is the public decision API: tool params land on command / filePath.
// Auditing is off so the fixture does not append to the operator audit log;
// action / modeAction / reason / matchedRule are still the live evaluate() result.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getPermissionModeManager,
  resetPermissionModeManager,
  type PermissionLevel,
  type PermissionMode,
} from '../../../src/host/permissions/modes';
import {
  PolicyEngine,
  type PolicyRule,
} from '../../../src/host/permissions/policyEngine';

const FIXED_NOW = 1_700_000_000_000;
const SESSION_ID = 'policy-golden';

export interface DecisionTableRow {
  id: string;
  mode: PermissionMode;
  parentMode?: PermissionMode;
  tool: string;
  level: PermissionLevel;
  description: string;
  filePath?: string;
  command?: string;
  rules?: PolicyRule[];
}

function rule(
  id: string,
  action: PolicyRule['action'],
  matcher: PolicyRule['matcher'],
  overridable: boolean,
  priority = 650,
): PolicyRule {
  return {
    id,
    name: id,
    priority,
    matcher,
    action,
    overridable,
    audit: action === 'deny',
  };
}

export const DECISION_TABLE: readonly DecisionTableRow[] = [
  {
    id: 'read-default-allow',
    mode: 'default',
    tool: 'Read',
    level: 'read',
    description: 'read a project file',
    filePath: '/tmp/project/README.md',
  },
  {
    id: 'write-default-ask',
    mode: 'default',
    tool: 'Write',
    level: 'write',
    description: 'write a project file',
    filePath: '/tmp/project/note.txt',
  },
  {
    id: 'admin-default-deny',
    mode: 'default',
    tool: 'Bash',
    level: 'admin',
    description: 'admin operation',
    command: 'id',
  },
  {
    id: 'rm-rf-root-deny',
    mode: 'default',
    tool: 'Bash',
    level: 'execute',
    description: 'delete root',
    command: 'rm -rf /',
  },
  {
    id: 'rm-rf-root-bypass-still-deny',
    mode: 'bypassPermissions',
    tool: 'Bash',
    level: 'execute',
    description: 'delete root under bypass',
    command: 'rm -rf /',
  },
  {
    id: 'git-force-push-ask',
    mode: 'default',
    tool: 'Bash',
    level: 'execute',
    description: 'force push',
    command: 'git push origin main --force',
  },
  {
    id: 'sudo-ask',
    mode: 'default',
    tool: 'Bash',
    level: 'execute',
    description: 'sudo',
    command: 'sudo ls',
  },
  {
    id: 'git-status-overridable-tightened-to-ask',
    mode: 'default',
    tool: 'Bash',
    level: 'execute',
    description: 'git status',
    command: 'git status',
  },
  {
    id: 'ls-overridable-tightened-to-ask',
    mode: 'default',
    tool: 'Bash',
    level: 'execute',
    description: 'list directory',
    command: 'ls /tmp',
  },
  {
    id: 'ssh-key-read-deny',
    mode: 'default',
    tool: 'Read',
    level: 'read',
    description: 'read a private key',
    filePath: '/home/user/.ssh/id_rsa',
  },
  {
    id: 'root-write-deny',
    mode: 'default',
    tool: 'Write',
    level: 'write',
    description: 'write under /usr',
    filePath: '/usr/bin/evil',
  },
  {
    id: 'env-write-ask',
    mode: 'default',
    tool: 'Write',
    level: 'write',
    description: 'write a home env file',
    filePath: '/Users/someone/.env',
  },
  {
    id: 'dontask-write-deny',
    mode: 'dontAsk',
    tool: 'Write',
    level: 'write',
    description: 'write while dontAsk',
    filePath: '/tmp/project/note.txt',
  },
  {
    id: 'accept-edits-write-allow',
    mode: 'acceptEdits',
    tool: 'Write',
    level: 'write',
    description: 'write while acceptEdits',
    filePath: '/tmp/project/note.txt',
  },
  {
    id: 'plan-exec-deny',
    mode: 'plan',
    tool: 'Bash',
    level: 'execute',
    description: 'echo while planning',
    command: 'echo hi',
  },
  {
    id: 'plan-tightens-overridable-allow',
    mode: 'plan',
    tool: 'Bash',
    level: 'execute',
    description: 'git status while planning',
    command: 'git status',
  },
  {
    id: 'bypass-exec-allow',
    mode: 'bypassPermissions',
    tool: 'Bash',
    level: 'execute',
    description: 'echo under bypass',
    command: 'echo hi',
  },
  {
    id: 'bypass-dangerous-ask',
    mode: 'bypassPermissions',
    tool: 'Bash',
    level: 'dangerous',
    description: 'dangerous under bypass',
    command: 'echo hi',
  },
  {
    id: 'readonly-network-allow',
    mode: 'readOnly',
    tool: 'WebFetch',
    level: 'network',
    description: 'fetch while readOnly',
  },
  {
    id: 'user-rule-deny',
    mode: 'default',
    tool: 'CustomTool',
    level: 'read',
    description: 'user deny rule',
    filePath: '/tmp/project/custom.txt',
    rules: [rule('user-deny-custom', 'deny', { tool: 'CustomTool' }, false, 700)],
  },
  {
    id: 'user-rule-ask',
    mode: 'acceptEdits',
    tool: 'Write',
    level: 'write',
    description: 'user ask rule beats acceptEdits',
    filePath: '/tmp/project/note.txt',
    rules: [rule('user-ask-write', 'prompt', { tool: 'Write', level: 'write' }, false, 800)],
  },
  {
    id: 'user-regex-deny',
    mode: 'bypassPermissions',
    tool: 'Bash',
    level: 'execute',
    description: 'regex deny',
    command: 'echo secret',
    rules: [rule('user-regex-secret', 'deny', { commandPattern: /echo\s+secret/ }, false, 900)],
  },
  {
    id: 'delegate-inherits-plan-write-deny',
    mode: 'delegate',
    parentMode: 'plan',
    tool: 'Write',
    level: 'write',
    description: 'delegate to plan',
    filePath: '/tmp/project/note.txt',
  },
  {
    id: 'custom-matcher-allow',
    mode: 'dontAsk',
    tool: 'Special',
    level: 'write',
    description: 'custom matcher allow',
    filePath: '/tmp/project/note.txt',
    rules: [rule('user-custom-allow', 'allow', { tool: 'Special', custom: () => true }, false, 50)],
  },
];

export function runPolicyDecisionTable(): string {
  const now = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    const outputs = DECISION_TABLE.map((row) => {
      resetPermissionModeManager();
      const manager = getPermissionModeManager();
      if (row.parentMode) manager.setParentMode(row.parentMode);
      if (!manager.setMode(row.mode, true) && manager.getMode() !== row.mode) {
        throw new Error(`mode ${row.mode} was not applied`);
      }
      const engine = new PolicyEngine();
      engine.setAuditEnabled(false);
      for (const extra of row.rules ?? []) engine.addRule(extra);
      const output = engine.evaluate({
        tool: row.tool,
        level: row.level,
        description: row.description,
        sessionId: SESSION_ID,
        filePath: row.filePath,
        command: row.command,
      });
      return { id: row.id, output };
    });
    return JSON.stringify(outputs);
  } finally {
    Date.now = now;
    resetPermissionModeManager();
  }
}

export function policyDecisionGoldenPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'policyDecisionGolden.json');
}

export function readPolicyDecisionGolden(): string {
  return readFileSync(policyDecisionGoldenPath(), 'utf8').trim();
}
