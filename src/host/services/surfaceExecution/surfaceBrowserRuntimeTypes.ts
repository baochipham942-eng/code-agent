import type {
  InteractiveSurfaceSessionV1,
  SurfaceActionResultV1,
  SurfaceElementRefV1,
  SurfaceExecutionEventV1,
  SurfaceExpectationV1,
  SurfaceObservationV1,
  SurfaceTargetRefV1,
} from '../../../shared/contract/surfaceExecution';
import { BROWSER_RELAY_LEASE_ACTION_SCOPES_V2 } from '../../../shared/contract/browserRelay';
import type { SurfaceGrantSubjectV1 } from './SurfaceAccessGrantService';
import type { BrowserTabOriginalPlacementV1 } from './BrowserTabLeaseService';
import type { SurfaceTakeoverResolutionV1 } from './SurfaceHumanTakeoverService';
import type { SurfaceProviderActionOutcomeV1 } from './SurfaceOperationCoordinator';

type SurfaceBrowserElementInputV1 = Omit<
  Extract<SurfaceElementRefV1, { kind: 'browser-element' }>,
  'stateId'
>;

export interface SurfaceBrowserActionDispatchV1<T> {
  providerResult: T;
  outcome: SurfaceProviderActionOutcomeV1;
}

export interface SurfaceBrowserActionExecutionV1<T> {
  providerResult: T;
  surfaceResult: SurfaceActionResultV1;
  session: InteractiveSurfaceSessionV1;
  events: SurfaceExecutionEventV1[];
}

interface BrowserSurfaceRuntimeIdentityV1 {
  conversationId: string;
  runId: string;
  turnId?: string;
  agentId: string;
  emitSurfaceEvent?: (event: SurfaceExecutionEventV1) => void;
}

export interface PrepareBrowserSessionInputV1 {
  identity: BrowserSurfaceRuntimeIdentityV1;
  provider?: string;
  switchReason?: string;
}

export interface PrepareBrowserSessionResultV1 {
  session: InteractiveSurfaceSessionV1;
  subject: SurfaceGrantSubjectV1;
}

export interface RecordBrowserObservationInputV1 extends PrepareBrowserSessionInputV1 {
  surfaceSessionId: string;
  target: Extract<SurfaceTargetRefV1, { kind: 'browser' }>;
  providerGeneration: string;
  elements?: SurfaceBrowserElementInputV1[];
  evidenceAssetIds?: string[];
  redactionStatus?: SurfaceObservationV1['redactionStatus'];
  ttlMs?: number;
  leaseId?: string;
  leaseAction?: string;
  userSummary?: string;
}

export interface RecordBrowserObservationResultV1 extends PrepareBrowserSessionResultV1 {
  observation: SurfaceObservationV1;
  events: SurfaceExecutionEventV1[];
}

export interface GetBrowserBindingInputV1 extends PrepareBrowserSessionInputV1 {
  surfaceSessionId: string;
  predecessorStateId: string;
}

export interface SurfaceBrowserBindingResultV1 {
  subject: SurfaceGrantSubjectV1;
  observation: SurfaceObservationV1;
}

export interface ExecuteBrowserActionInputV1<T> extends GetBrowserBindingInputV1 {
  leaseId?: string;
  operationId: string;
  action: string;
  arguments: Record<string, unknown>;
  expectation?: SurfaceExpectationV1;
  parentSignal?: AbortSignal;
  deadlineMs?: number;
  releaseInput?: () => void | Promise<void>;
  dispatch(signal: AbortSignal, subject: SurfaceGrantSubjectV1): Promise<SurfaceBrowserActionDispatchV1<T>>;
}

export interface RegisterBrowserTabLeaseCleanupInputV1 {
  identity: BrowserSurfaceRuntimeIdentityV1;
  surfaceSessionId: string;
  leaseId: string;
  restore(placement: Readonly<BrowserTabOriginalPlacementV1>): void | Promise<void>;
}

export interface SurfaceTakeoverControlV1 {
  requestId: string;
  wait: Promise<SurfaceTakeoverResolutionV1>;
}

export interface BrowserStateBinding {
  provider: string;
  subject: SurfaceGrantSubjectV1;
  surfaceStateId: string;
}

export const BROWSER_SURFACE_OPERATIONS = [
  'launch', 'close', 'new_tab', 'close_tab', 'switch_tab', 'navigate',
  'back', 'forward', 'reload', 'set_viewport', 'click', 'click_text',
  'type', 'press_key', 'scroll', 'wait_for_download', 'upload_file',
  'fill_form', 'list_tabs', 'screenshot', 'get_content', 'get_elements',
  'get_dom_snapshot', 'get_a11y_snapshot', 'get_workbench_state',
  'get_account_state', 'export_storage_state', 'import_storage_state',
  'wait', 'get_logs', 'list_profiles', 'import_profile_cookies', 'clear_cookies',
];

export const RELAY_BROWSER_SURFACE_OPERATIONS = [
  'launch',
  ...BROWSER_RELAY_LEASE_ACTION_SCOPES_V2.filter((action) => action !== 'lease:return'),
];

export const DEFAULT_BROWSER_PROVIDER = 'system-chrome-cdp';
export const RELAY_BROWSER_PROVIDER = 'browser-relay';
