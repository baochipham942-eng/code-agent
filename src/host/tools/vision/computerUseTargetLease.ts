// Turn-scoped memory of the last desktop app an allowed computer action named.
// A later type/key that omits targetApp is refused so keystrokes cannot fall
// through to whatever window is frontmost. The first untargeted action in a
// turn with no lease is unchanged.

const MAX_LEASES = 50;
const leases = new Map<string, string>();
const KEYSTROKE_ACTIONS = new Set(['type', 'key']);
const COMPUTER_TOOL_NAMES = new Set(['computer_use', 'Computer']);

interface ComputerTargetLeaseIdentity {
  sessionId?: string;
  turnId?: string;
  agentId?: string;
}

interface LeasedAction {
  action?: string;
  targetApp?: string;
  actions?: LeasedAction[];
}

interface ComputerTargetLeaseRefusal {
  code: 'COMPUTER_TARGET_REQUIRED';
  error: string;
}

function leaseKey(identity: ComputerTargetLeaseIdentity): string | null {
  const sessionId = identity.sessionId?.trim();
  const turnId = identity.turnId?.trim();
  const agentId = identity.agentId?.trim();
  if (!sessionId || !turnId || !agentId) return null;
  return `${sessionId}:${turnId}:${agentId}`;
}

function readAppName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length > 0 ? name : null;
}

function asLeasedAction(value: unknown): LeasedAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as LeasedAction;
}

/** Parent targetApp, then each computer_batch sub-action, in order. */
function declaredAppNames(action: LeasedAction | null): string[] {
  if (!action) return [];
  const names: string[] = [];
  const own = readAppName(action.targetApp);
  if (own) names.push(own);
  if (action.action === 'computer_batch' && Array.isArray(action.actions)) {
    for (const raw of action.actions) {
      const sub = asLeasedAction(raw);
      const name = sub ? readAppName(sub.targetApp) : null;
      if (name) names.push(name);
    }
  }
  return names;
}

function remember(key: string, appName: string): void {
  if (leases.has(key)) leases.delete(key);
  leases.set(key, appName);
  while (leases.size > MAX_LEASES) {
    const oldest = leases.keys().next().value;
    if (oldest === undefined) break;
    leases.delete(oldest);
  }
}

function quotedApp(appName: string): string {
  return appName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function leaseRefusalText(appName: string): string {
  const quoted = quotedApp(appName);
  return `This turn is operating ${appName}; resend with targetApp:"${quoted}" and axPath from get_ax_elements or locate_role.`;
}

/**
 * Call only after authorizeAction allowed the action. Records the last
 * targetApp carried by that action, including computer_batch sub-actions.
 */
export function recordTarget(identity: ComputerTargetLeaseIdentity, action: LeasedAction): void {
  const key = leaseKey(identity);
  if (!key) return;
  const names = declaredAppNames(action);
  const appName = names[names.length - 1];
  if (!appName) return;
  remember(key, appName);
}

function hasUntargetedKeystroke(action: LeasedAction | null): boolean {
  if (!action) return false;
  if (KEYSTROKE_ACTIONS.has(action.action || '') && !readAppName(action.targetApp)) return true;
  if (action.action !== 'computer_batch' || !Array.isArray(action.actions)) return false;
  return action.actions.some((raw) => {
    const sub = asLeasedAction(raw);
    return Boolean(sub && KEYSTROKE_ACTIONS.has(sub.action || '') && !readAppName(sub.targetApp));
  });
}

/** Refusal for type/key (including computer_batch sub-actions) when a lease exists and targetApp is empty. */
export function checkLease(
  action: LeasedAction,
  identity: ComputerTargetLeaseIdentity,
): ComputerTargetLeaseRefusal | null {
  const key = leaseKey(identity);
  if (!key) return null;
  const appName = leases.get(key);
  if (!appName || !hasUntargetedKeystroke(action)) return null;
  return {
    code: 'COMPUTER_TARGET_REQUIRED',
    error: leaseRefusalText(appName),
  };
}

/**
 * App to show for a computer step: the action's own targetApp (last one in a
 * batch), otherwise the turn lease. Other tools return undefined.
 */
export function computerUseObservedTarget(
  toolName: string,
  args: Record<string, unknown> | undefined,
  identity: ComputerTargetLeaseIdentity,
): string | undefined {
  if (!COMPUTER_TOOL_NAMES.has(toolName)) return undefined;
  const names = declaredAppNames(asLeasedAction(args));
  if (names.length > 0) return names[names.length - 1];
  const key = leaseKey(identity);
  if (!key) return undefined;
  return leases.get(key);
}
