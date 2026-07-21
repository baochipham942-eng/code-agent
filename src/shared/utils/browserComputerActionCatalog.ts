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

export interface BrowserComputerSurfaceCapabilityDescriptor {
  surface: "browser" | "computer";
  actionClass: string;
  capabilities: Array<"observe" | "input" | "navigate" | "file" | "secret" | "destructive">;
  mutation: boolean;
  catalog: BrowserComputerActionCatalogEntry;
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
  hover: WRITE_BROWSER_DEFAULTS,
  drag: WRITE_BROWSER_DEFAULTS,
  get_dialog_state: {
    ...READ_BROWSER_DEFAULTS,
    evidenceKind: "workbench_state",
  },
  handle_dialog: WRITE_BROWSER_DEFAULTS,
  read_clipboard: {
    ...READ_BROWSER_DEFAULTS,
    evidenceKind: "workbench_state",
  },
  write_clipboard: WRITE_BROWSER_DEFAULTS,
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
  list_profiles: {
    ...READ_BROWSER_DEFAULTS,
    requiresManagedSession: false,
    evidenceKind: "account_state",
    safeRecovery: "none",
  },
  import_profile_cookies: {
    ...WRITE_BROWSER_DEFAULTS,
    evidenceKind: "account_state",
    approvalKind: "tool_executor_file",
  },
  clear_cookies: {
    ...WRITE_BROWSER_DEFAULTS,
    evidenceKind: "account_state",
  },
};

const COMPUTER_USE_DESKTOP_CATALOG: ActionCatalogMap = {
  list_roots: {
    ...DESKTOP_READ_DEFAULTS,
    evidenceKind: "window_candidates",
  },
  get_state: {
    ...DESKTOP_READ_DEFAULTS,
    evidenceKind: "computer_surface_state",
  },
  observe: {
    ...DESKTOP_READ_DEFAULTS,
    evidenceKind: "desktop_observation",
  },
  act: DESKTOP_INPUT_DEFAULTS,
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
  mouse_down: DESKTOP_INPUT_DEFAULTS,
  mouse_up: DESKTOP_INPUT_DEFAULTS,
  open_application: DESKTOP_INPUT_DEFAULTS,
  write_clipboard: DESKTOP_INPUT_DEFAULTS,
  computer_batch: DESKTOP_INPUT_DEFAULTS,
  hold_key: DESKTOP_INPUT_DEFAULTS,
  triple_click: DESKTOP_INPUT_DEFAULTS,
  cursor_position: {
    ...DESKTOP_READ_DEFAULTS,
    evidenceKind: "desktop_observation",
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

function isRegisteredBrowserComputerAction(
  toolName: BrowserComputerCatalogTool,
  action: string,
  args?: Record<string, unknown>,
): boolean {
  if (toolName === "browser_action") {
    return Object.prototype.hasOwnProperty.call(BROWSER_ACTION_CATALOG, action);
  }
  const catalog = isBrowserScopedComputerUseAction(action, args)
    ? COMPUTER_USE_BROWSER_SCOPED_CATALOG
    : COMPUTER_USE_DESKTOP_CATALOG;
  return Object.prototype.hasOwnProperty.call(catalog, action);
}

export function getStrictBrowserComputerActionCatalogEntry(
  toolName: unknown,
  action: unknown,
  args?: Record<string, unknown>,
): BrowserComputerActionCatalogEntry | null {
  if (!isBrowserComputerCatalogToolName(toolName) || typeof action !== "string") {
    return null;
  }
  if (!isRegisteredBrowserComputerAction(toolName, action, args)) {
    return null;
  }
  return getBrowserComputerActionCatalogEntry(toolName, action, args);
}

function capabilitiesForCatalogEntry(
  entry: BrowserComputerActionCatalogEntry,
  args?: Record<string, unknown>,
): BrowserComputerSurfaceCapabilityDescriptor["capabilities"] {
  const capabilities: BrowserComputerSurfaceCapabilityDescriptor["capabilities"] = [];
  if (entry.risk === "read") capabilities.push("observe");
  if (entry.risk === "browser_action" || entry.risk === "desktop_input") capabilities.push("input");
  if (["launch", "close", "new_tab", "close_tab", "switch_tab", "navigate", "back", "forward", "reload"].includes(entry.action)) {
    capabilities.push("navigate");
  }
  if (entry.approvalKind === "tool_executor_file") capabilities.push("file");
  if (["import_profile_cookies", "import_storage_state", "export_storage_state"].includes(entry.action)
    || containsSecretRef(args)) {
    capabilities.push("secret");
  }
  if (["read_clipboard", "write_clipboard"].includes(entry.action)
    || (entry.action === "handle_dialog" && typeof args?.dialogPromptText === "string")) {
    capabilities.push("secret");
  }
  if (entry.action === "clear_cookies"
    || (entry.action === "handle_dialog" && args?.dialogAction === "accept")
    || args?.destructive === true) capabilities.push("destructive");
  return Array.from(new Set(capabilities));
}

function containsSecretRef(value: unknown, depth = 0): boolean {
  if (depth > 5 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsSecretRef(item, depth + 1));
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "secretRef" && typeof child === "string" && child.trim().length > 0) return true;
    if (containsSecretRef(child, depth + 1)) return true;
  }
  return false;
}

export function getBrowserComputerSurfaceCapabilityDescriptor(
  toolName: unknown,
  action: unknown,
  args?: Record<string, unknown>,
): BrowserComputerSurfaceCapabilityDescriptor | null {
  const catalog = getStrictBrowserComputerActionCatalogEntry(toolName, action, args);
  if (!catalog) return null;
  const surface = catalog.scope === "desktop_surface" ? "computer" : "browser";
  return {
    surface,
    actionClass: `${catalog.scope}:${catalog.action}`,
    capabilities: capabilitiesForCatalogEntry(catalog, args),
    // Clipboard reads cross a sensitive browser boundary. Treat them as an
    // operation even though they do not mutate the page so the runtime issues
    // and consumes a capability-scoped Surface grant instead of taking the
    // observation fast path.
    mutation: catalog.risk !== "read" || catalog.action === "read_clipboard",
    catalog,
  };
}

export function getBrowserComputerActionCatalogForArgs(args: {
  toolName: unknown;
  arguments?: Record<string, unknown>;
}): BrowserComputerActionCatalogEntry | null {
  const action = isRecord(args.arguments)
    ? args.arguments.action ?? args.arguments.operation
    : undefined;
  return getBrowserComputerActionCatalogEntry(
    args.toolName,
    action,
    isRecord(args.arguments) ? args.arguments : undefined,
  );
}
