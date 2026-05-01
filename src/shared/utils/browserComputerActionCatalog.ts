export type BrowserComputerCatalogTool = "browser_action" | "computer_use";

export type BrowserComputerCatalogRisk =
  | "read"
  | "browser_action"
  | "desktop_input";

export type BrowserComputerCatalogScope =
  | "managed_browser"
  | "browser_scoped_computer"
  | "desktop_surface";

export type BrowserComputerCatalogEvidenceKind =
  | "none"
  | "action_trace"
  | "dom_snapshot"
  | "a11y_snapshot"
  | "screenshot"
  | "page_content"
  | "workbench_state"
  | "account_state"
  | "storage_state"
  | "artifact"
  | "browser_logs"
  | "computer_surface_state"
  | "desktop_observation"
  | "ax_candidates"
  | "window_candidates"
  | "app_diagnostics"
  | "target_resolution";

export type BrowserComputerCatalogApprovalKind =
  | "tool_executor"
  | "tool_executor_read_only"
  | "tool_executor_file"
  | "tool_executor_desktop_surface";

export type BrowserComputerCatalogSafeRecovery =
  | "none"
  | "launch_managed_browser"
  | "refresh_managed_snapshot"
  | "desktop_readonly_probe";

export interface BrowserComputerActionCatalogEntry {
  tool: BrowserComputerCatalogTool;
  action: string;
  risk: BrowserComputerCatalogRisk;
  scope: BrowserComputerCatalogScope;
  requiresManagedSession: boolean;
  evidenceKind: BrowserComputerCatalogEvidenceKind;
  approvalKind: BrowserComputerCatalogApprovalKind;
  safeRecovery: BrowserComputerCatalogSafeRecovery;
}

type ActionCatalogDefaults = Omit<BrowserComputerActionCatalogEntry, "tool" | "action">;
type ActionCatalogMap = Record<string, Partial<ActionCatalogDefaults>>;

const READ_BROWSER_DEFAULTS: ActionCatalogDefaults = {
  risk: "read",
  scope: "managed_browser",
  requiresManagedSession: true,
  evidenceKind: "dom_snapshot",
  approvalKind: "tool_executor_read_only",
  safeRecovery: "refresh_managed_snapshot",
};

const WRITE_BROWSER_DEFAULTS: ActionCatalogDefaults = {
  risk: "browser_action",
  scope: "managed_browser",
  requiresManagedSession: true,
  evidenceKind: "action_trace",
  approvalKind: "tool_executor",
  safeRecovery: "refresh_managed_snapshot",
};

const DESKTOP_READ_DEFAULTS: ActionCatalogDefaults = {
  risk: "read",
  scope: "desktop_surface",
  requiresManagedSession: false,
  evidenceKind: "computer_surface_state",
  approvalKind: "tool_executor_read_only",
  safeRecovery: "desktop_readonly_probe",
};

const DESKTOP_INPUT_DEFAULTS: ActionCatalogDefaults = {
  risk: "desktop_input",
  scope: "desktop_surface",
  requiresManagedSession: false,
  evidenceKind: "action_trace",
  approvalKind: "tool_executor_desktop_surface",
  safeRecovery: "desktop_readonly_probe",
};

const BROWSER_SCOPED_COMPUTER_READ_DEFAULTS: ActionCatalogDefaults = {
  risk: "read",
  scope: "browser_scoped_computer",
  requiresManagedSession: true,
  evidenceKind: "target_resolution",
  approvalKind: "tool_executor_read_only",
  safeRecovery: "refresh_managed_snapshot",
};

const BROWSER_SCOPED_COMPUTER_INPUT_DEFAULTS: ActionCatalogDefaults = {
  risk: "browser_action",
  scope: "browser_scoped_computer",
  requiresManagedSession: true,
  evidenceKind: "action_trace",
  approvalKind: "tool_executor",
  safeRecovery: "refresh_managed_snapshot",
};

const BROWSER_ACTION_CATALOG: ActionCatalogMap = {
  launch: {
    ...WRITE_BROWSER_DEFAULTS,
    requiresManagedSession: false,
    evidenceKind: "workbench_state",
    safeRecovery: "launch_managed_browser",
  },
  close: {
    ...WRITE_BROWSER_DEFAULTS,
    evidenceKind: "workbench_state",
    safeRecovery: "none",
  },
  new_tab: WRITE_BROWSER_DEFAULTS,
  close_tab: WRITE_BROWSER_DEFAULTS,
  switch_tab: WRITE_BROWSER_DEFAULTS,
  navigate: WRITE_BROWSER_DEFAULTS,
  back: WRITE_BROWSER_DEFAULTS,
  forward: WRITE_BROWSER_DEFAULTS,
  reload: WRITE_BROWSER_DEFAULTS,
  set_viewport: WRITE_BROWSER_DEFAULTS,
  click: WRITE_BROWSER_DEFAULTS,
  click_text: WRITE_BROWSER_DEFAULTS,
  type: WRITE_BROWSER_DEFAULTS,
  press_key: WRITE_BROWSER_DEFAULTS,
  scroll: WRITE_BROWSER_DEFAULTS,
  wait_for_download: {
    ...WRITE_BROWSER_DEFAULTS,
    evidenceKind: "artifact",
  },
  upload_file: {
    ...WRITE_BROWSER_DEFAULTS,
    evidenceKind: "artifact",
    approvalKind: "tool_executor_file",
  },
  fill_form: WRITE_BROWSER_DEFAULTS,
  list_tabs: {
    ...READ_BROWSER_DEFAULTS,
    evidenceKind: "workbench_state",
  },
  screenshot: {
    ...READ_BROWSER_DEFAULTS,
    evidenceKind: "screenshot",
  },
  get_content: {
    ...READ_BROWSER_DEFAULTS,
    evidenceKind: "page_content",
  },
  get_elements: {
    ...READ_BROWSER_DEFAULTS,
    evidenceKind: "dom_snapshot",
  },
  get_dom_snapshot: {
    ...READ_BROWSER_DEFAULTS,
    evidenceKind: "dom_snapshot",
  },
  get_a11y_snapshot: {
    ...READ_BROWSER_DEFAULTS,
    evidenceKind: "a11y_snapshot",
  },
  get_workbench_state: {
    ...READ_BROWSER_DEFAULTS,
    evidenceKind: "workbench_state",
    safeRecovery: "launch_managed_browser",
  },
  get_account_state: {
    ...READ_BROWSER_DEFAULTS,
    evidenceKind: "account_state",
  },
  export_storage_state: {
    ...READ_BROWSER_DEFAULTS,
    evidenceKind: "storage_state",
    approvalKind: "tool_executor_file",
  },
  import_storage_state: {
    ...WRITE_BROWSER_DEFAULTS,
    evidenceKind: "storage_state",
    approvalKind: "tool_executor_file",
  },
  wait: READ_BROWSER_DEFAULTS,
  get_logs: {
    ...READ_BROWSER_DEFAULTS,
    evidenceKind: "browser_logs",
  },
};

const COMPUTER_USE_DESKTOP_CATALOG: ActionCatalogMap = {
  get_state: {
    ...DESKTOP_READ_DEFAULTS,
    evidenceKind: "computer_surface_state",
  },
  observe: {
    ...DESKTOP_READ_DEFAULTS,
    evidenceKind: "desktop_observation",
  },
  get_ax_elements: {
    ...DESKTOP_READ_DEFAULTS,
    evidenceKind: "ax_candidates",
  },
  get_windows: {
    ...DESKTOP_READ_DEFAULTS,
    evidenceKind: "window_candidates",
  },
  diagnose_app: {
    ...DESKTOP_READ_DEFAULTS,
    evidenceKind: "app_diagnostics",
  },
  click: DESKTOP_INPUT_DEFAULTS,
  doubleClick: DESKTOP_INPUT_DEFAULTS,
  rightClick: DESKTOP_INPUT_DEFAULTS,
  move: DESKTOP_INPUT_DEFAULTS,
  type: DESKTOP_INPUT_DEFAULTS,
  key: DESKTOP_INPUT_DEFAULTS,
  scroll: DESKTOP_INPUT_DEFAULTS,
  drag: DESKTOP_INPUT_DEFAULTS,
  locate_role: {
    ...DESKTOP_READ_DEFAULTS,
    evidenceKind: "ax_candidates",
  },
};

const COMPUTER_USE_BROWSER_SCOPED_CATALOG: ActionCatalogMap = {
  locate_element: BROWSER_SCOPED_COMPUTER_READ_DEFAULTS,
  locate_text: BROWSER_SCOPED_COMPUTER_READ_DEFAULTS,
  locate_role: BROWSER_SCOPED_COMPUTER_READ_DEFAULTS,
  get_elements: {
    ...BROWSER_SCOPED_COMPUTER_READ_DEFAULTS,
    evidenceKind: "dom_snapshot",
  },
  smart_click: BROWSER_SCOPED_COMPUTER_INPUT_DEFAULTS,
  smart_type: BROWSER_SCOPED_COMPUTER_INPUT_DEFAULTS,
  smart_hover: BROWSER_SCOPED_COMPUTER_INPUT_DEFAULTS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasTargetApp(args: Record<string, unknown> | undefined): boolean {
  const value = args?.targetApp;
  return typeof value === "string" && value.trim().length > 0;
}

function buildCatalogEntry(
  tool: BrowserComputerCatalogTool,
  action: string,
  defaults: ActionCatalogDefaults,
  overrides?: Partial<ActionCatalogDefaults>,
): BrowserComputerActionCatalogEntry {
  return {
    tool,
    action,
    ...defaults,
    ...overrides,
  };
}

export function isBrowserComputerCatalogToolName(
  toolName: unknown,
): toolName is BrowserComputerCatalogTool {
  return toolName === "browser_action" || toolName === "computer_use";
}

export function isBrowserScopedComputerUseAction(
  action: unknown,
  args?: Record<string, unknown>,
): boolean {
  if (typeof action !== "string") {
    return false;
  }
  if (hasTargetApp(args)) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(
    COMPUTER_USE_BROWSER_SCOPED_CATALOG,
    action,
  );
}

export function getBrowserComputerActionCatalogEntry(
  toolName: unknown,
  action: unknown,
  args?: Record<string, unknown>,
): BrowserComputerActionCatalogEntry | null {
  if (!isBrowserComputerCatalogToolName(toolName) || typeof action !== "string") {
    return null;
  }

  if (toolName === "browser_action") {
    const overrides = BROWSER_ACTION_CATALOG[action];
    return buildCatalogEntry(
      "browser_action",
      action,
      WRITE_BROWSER_DEFAULTS,
      overrides,
    );
  }

  if (isBrowserScopedComputerUseAction(action, args)) {
    const overrides = COMPUTER_USE_BROWSER_SCOPED_CATALOG[action];
    const defaults = overrides?.risk === "read"
      ? BROWSER_SCOPED_COMPUTER_READ_DEFAULTS
      : BROWSER_SCOPED_COMPUTER_INPUT_DEFAULTS;
    return buildCatalogEntry("computer_use", action, defaults, overrides);
  }

  const overrides = COMPUTER_USE_DESKTOP_CATALOG[action];
  const defaults = overrides?.risk === "read"
    ? DESKTOP_READ_DEFAULTS
    : DESKTOP_INPUT_DEFAULTS;
  return buildCatalogEntry("computer_use", action, defaults, overrides);
}

export function getBrowserComputerActionCatalogForArgs(args: {
  toolName: unknown;
  arguments?: Record<string, unknown>;
}): BrowserComputerActionCatalogEntry | null {
  const action = isRecord(args.arguments) ? args.arguments.action : undefined;
  return getBrowserComputerActionCatalogEntry(
    args.toolName,
    action,
    isRecord(args.arguments) ? args.arguments : undefined,
  );
}
