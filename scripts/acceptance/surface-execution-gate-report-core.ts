import type {
  SurfaceAcceptanceCampaignV1,
  SurfaceAcceptanceSourceFingerprintV1,
} from './surface-execution-proof.ts';

export const SURFACE_GATE_PROOF_PATHS = {
  managed: 'docs/acceptance/surface-execution/managed-current/proof.json',
  relay: 'docs/acceptance/surface-execution/relay-current/proof.json',
  computer: 'docs/acceptance/surface-execution/computer-current/proof.json',
  crossSurface: 'docs/acceptance/surface-execution/cross-surface-current/proof.json',
  workbuddy: 'docs/acceptance/surface-execution/workbuddy-current/proof.json',
  conversation: 'docs/acceptance/surface-execution/conversation-current/proof.json',
  durable: 'docs/acceptance/surface-execution/durable-current/proof.json',
  stopBenchmark: 'docs/acceptance/surface-execution/stop-benchmark-current/proof.json',
} as const;

export type SurfaceGateProofId = keyof typeof SURFACE_GATE_PROOF_PATHS;
export type SurfaceGateStatus =
  | 'passed'
  | 'failed'
  | 'stale'
  | 'missing'
  | 'blocked_external'
  | 'evidence_backed_defer';

export interface ArtifactRequirement {
  recordPath: string;
  fileField?: string;
  sha256Field?: string;
  bytesField?: string;
  minCount?: number;
}

export interface ArtifactFact {
  declaredPath?: string;
  resolvedPath?: string;
  expectedSha256?: string;
  expectedBytes?: number;
  exists: boolean;
  insideProofDirectory: boolean;
  actualSha256?: string;
  actualBytes?: number;
  mtimeMs?: number;
  readError?: string;
}

export interface ProofBinding {
  proof: SurfaceGateProofId;
  assertions: string[];
  assertionAliases?: Record<string, string[]>;
  artifacts?: ArtifactRequirement[];
  readbacks?: string[];
}

export interface ProofDeferRequirement {
  proof: SurfaceGateProofId;
  recordPaths: string[];
  capability?: string;
  fallback: 'managed';
  gate: 'G3' | 'G4';
}

export interface SurfaceGateDefinition {
  id: string;
  title: string;
  bindings: ProofBinding[];
  defer?: ProofDeferRequirement;
}

export interface EvidenceBackedDefer {
  gate: 'G3' | 'G4' | string;
  reason: string;
  evidenceObserved: string[];
  evidenceRequired: string[];
}

export interface CompletionRowDefinition {
  phase: 'P0' | 'P1' | 'P2';
  id: string;
  title: string;
  gateIds?: string[];
  bindings?: ProofBinding[];
  defer?: EvidenceBackedDefer;
}

export interface LoadedSurfaceProof {
  id: SurfaceGateProofId;
  path: string;
  document?: unknown;
  loadError?: string;
  proofFileMtimeMs?: number;
  artifactFacts?: Record<string, ArtifactFact[]>;
}

export interface SurfaceGateGitEvidence {
  worktree: string;
  head: string;
  originMain: string;
  mergeBase: string;
  commands: Array<{
    argv: string[];
    stdout: string;
    exitCode: number;
  }>;
}

export interface SurfaceGateEvaluationInput {
  generatedAt: string;
  truthSource: string;
  invocation: string[];
  campaign?: SurfaceAcceptanceCampaignV1;
  currentSourceFingerprint: SurfaceAcceptanceSourceFingerprintV1;
  git: SurfaceGateGitEvidence;
  proofs: Partial<Record<SurfaceGateProofId, LoadedSurfaceProof>>;
  t0?: SurfaceGateDefinition[];
  t1?: SurfaceGateDefinition[];
  completionRows?: CompletionRowDefinition[];
}

export interface ProofInventoryResult {
  id: SurfaceGateProofId;
  path: string;
  status: Exclude<SurfaceGateStatus, 'evidence_backed_defer'>;
  recordedStatus?: string;
  issues: string[];
}

export interface BindingEvaluation {
  proof: SurfaceGateProofId;
  proofPath: string;
  assertionKeys: string[];
  assertionCandidates: Record<string, string[]>;
  resolvedAssertionKeys: string[];
  artifactRecordPaths: string[];
  readbackPaths: string[];
  status: Exclude<SurfaceGateStatus, 'evidence_backed_defer'>;
  issues: string[];
}

export interface GateEvaluation {
  id: string;
  title: string;
  status: SurfaceGateStatus;
  evidence: BindingEvaluation[];
  deferEvidence?: {
    proof: SurfaceGateProofId;
    proofPath: string;
    recordPaths: string[];
    status: SurfaceGateStatus;
    defer?: EvidenceBackedDefer & { fallback: 'managed'; capability?: string };
    issues: string[];
  };
}

export interface CompletionRowEvaluation {
  phase: 'P0' | 'P1' | 'P2';
  id: string;
  title: string;
  status: SurfaceGateStatus;
  gateIds: string[];
  evidence: BindingEvaluation[];
  gateDefers: Array<NonNullable<GateEvaluation['deferEvidence']> & {
    gateId: string;
    gateTitle: string;
  }>;
  defer?: EvidenceBackedDefer;
  issues: string[];
}

export interface SurfaceGateReport {
  version: 1;
  generatedAt: string;
  truthSource: string;
  invocation: string[];
  campaign?: SurfaceAcceptanceCampaignV1;
  currentSourceFingerprint: SurfaceAcceptanceSourceFingerprintV1;
  git: SurfaceGateGitEvidence;
  proofInventory: ProofInventoryResult[];
  t0: GateEvaluation[];
  t1: GateEvaluation[];
  completion: Record<'P0' | 'P1' | 'P2', CompletionRowEvaluation[]>;
  overall: {
    status: Exclude<SurfaceGateStatus, 'evidence_backed_defer'>;
    exitCode: 0 | 1;
    hasEvidenceBackedDefers: boolean;
    blockingStatuses: SurfaceGateStatus[];
  };
}

const screenshot = (recordPath: string): ArtifactRequirement => ({ recordPath });
const managedComplexArtifact = (task: string): ArtifactRequirement => (
  screenshot(`complexEvidence.${task}.screenshot`)
);

export const SURFACE_T0_GATES: SurfaceGateDefinition[] = [
  {
    id: 't0-01-unauthorized-read-write',
    title: '未授权 tab 读取和写入均在协议层拒绝',
    bindings: [{
      proof: 'relay',
      assertions: ['unauthorizedBeforeLeaseBlocked', 'unauthorizedWriteBeforeLeaseBlocked'],
      assertionAliases: {
        unauthorizedWriteBeforeLeaseBlocked: [
          'unauthorizedMutationBeforeLeaseBlocked',
          'unauthorizedInputBeforeLeaseBlocked',
        ],
      },
    }],
  },
  {
    id: 't0-02-exact-tab-scope',
    title: 'Grant 只允许用户明确批准的 tab',
    bindings: [{
      proof: 'relay',
      assertions: ['explicitPopupApproval', 'exactTabApproved'],
      artifacts: [{
        recordPath: 'popupEvidence[]',
        fileField: 'screenshotPath',
        sha256Field: 'screenshotSha256',
        bytesField: 'screenshotBytes',
        minCount: 1,
      }],
    }],
  },
  {
    id: 't0-03-exact-domain-scope',
    title: 'Grant 越域访问被拒绝',
    bindings: [{ proof: 'relay', assertions: ['exactDomainBlocked'] }],
  },
  {
    id: 't0-04-exact-action-scope',
    title: 'Grant 未授权 action 被拒绝',
    bindings: [{ proof: 'relay', assertions: ['exactActionBlocked'] }],
  },
  {
    id: 't0-05-exact-time-scope',
    title: 'Grant 到期后 action 被拒绝',
    bindings: [{ proof: 'relay', assertions: ['exactTimeExpiryBlocked'] }],
  },
  {
    id: 't0-06-cross-agent-session-isolation',
    title: '跨 Agent、Session 和 continuation 所有权不可串线',
    bindings: [
      { proof: 'managed', assertions: ['crossAgentTargetBlocked'] },
      { proof: 'relay', assertions: ['crossAgentBlocked', 'agentWindowIsolation'] },
      { proof: 'durable', assertions: ['continuationOwnerScoped', 'continuationSingleUse'] },
    ],
  },
  {
    id: 't0-07-stale-target-fence',
    title: '旧 document/element ref 不可在 successor state 重用',
    bindings: [{ proof: 'relay', assertions: ['staleElementRefBlocked'] }],
  },
  {
    id: 't0-08-pause-takeover-fence',
    title: 'Pause 与 takeover 独立阻断 mutation 并可明确恢复',
    bindings: [{
      proof: 'managed',
      assertions: ['independentPause', 'pauseResume', 'takeoverBlockedMutation', 'takeoverResume'],
    }],
  },
  {
    id: 't0-09-stop-cancel-fence',
    title: 'Stop p95 小于两秒且停止后无新增 mutation',
    bindings: [{
      proof: 'stopBenchmark',
      assertions: [
        'independentRealSamples',
        'stopP95BelowTwoSeconds',
        'noPostStopMutation',
        'cleanupReleasedEverySample',
      ],
    }],
  },
  {
    id: 't0-10-cleanup-and-return',
    title: '正常、Stop 和断线路径释放 browser、tab 与 Computer lock',
    bindings: [
      { proof: 'managed', assertions: ['cleanupReleasedAllSessions'] },
      {
        proof: 'relay',
        assertions: ['exactTabPlacementReturned', 'orphanedTabReturned'],
      },
      { proof: 'computer', assertions: ['fixtureTerminated', 'mcpDisconnected'] },
      { proof: 'stopBenchmark', assertions: ['cleanupReleasedEverySample'] },
    ],
  },
  {
    id: 't0-11-protocol-version-mismatch',
    title: 'Relay 握手与版本偏差 fail-closed',
    bindings: [{
      proof: 'relay',
      assertions: ['handshakeAndCapabilities', 'protocolVersionMismatchBlocked'],
      assertionAliases: {
        protocolVersionMismatchBlocked: ['protocolMismatchBlocked', 'versionMismatchFailClosed'],
      },
    }],
  },
  {
    id: 't0-12-redaction-and-secret-leak',
    title: 'Canary 与 pairing material 不进入 proof、持久化或会话投影',
    bindings: [
      { proof: 'managed', assertions: ['redactionCanaryAbsent'] },
      { proof: 'relay', assertions: ['redactionCanaryAbsent', 'rawPairingMaterialAbsent'] },
      { proof: 'crossSurface', assertions: ['redactionCanaryAbsent'] },
      { proof: 'workbuddy', assertions: ['redactionCanaryAbsent'] },
      {
        proof: 'conversation',
        assertions: ['redaction_canary_dom_absence', 'redaction_canary_proof_absence'],
      },
      { proof: 'durable', assertions: ['canaryRedactedBeforeDisk', 'redactionCanaryAbsent'] },
    ],
  },
];

export const SURFACE_T1_GATES: SurfaceGateDefinition[] = [
  {
    id: 't1-01-react-reorder',
    title: 'React 重排后重新观察并命中正确业务目标',
    bindings: [{
      proof: 'managed',
      assertions: ['reactReorderFreshObservationVerified'],
      assertionAliases: {
        reactReorderFreshObservationVerified: ['reactReorderBusinessStateVerified'],
      },
      artifacts: [managedComplexArtifact('reactReorder')],
      readbacks: ['complexEvidence.reactReorder.businessReadback'],
    }],
  },
  {
    id: 't1-02-iframe',
    title: 'iframe 内目标使用 frame/document identity 完成业务读回',
    bindings: [{
      proof: 'managed',
      assertions: ['iframeExactTargetVerified'],
      assertionAliases: {
        iframeExactTargetVerified: ['iframeBusinessStateVerified'],
      },
      artifacts: [managedComplexArtifact('iframe')],
      readbacks: ['complexEvidence.iframe.businessReadback'],
    }],
  },
  {
    id: 't1-03-oopif',
    title: '跨站 OOPIF 在无专用 CDP session 时明确 fail-closed',
    bindings: [{
      proof: 'managed',
      assertions: ['oopifUnavailableFailClosed'],
      assertionAliases: {
        oopifUnavailableFailClosed: ['oopifRequiresDedicatedSessionFailClosed'],
      },
      artifacts: [managedComplexArtifact('oopif')],
      readbacks: ['complexEvidence.oopif.businessReadback'],
    }],
  },
  {
    id: 't1-04-shadow-dom',
    title: 'Open Shadow DOM ref 可执行且 Closed Shadow 不泄漏假 ref',
    bindings: [{
      proof: 'managed',
      assertions: ['openShadowTargetVerified', 'closedShadowFailClosed'],
      assertionAliases: {
        openShadowTargetVerified: ['openShadowDomBusinessStateVerified'],
        closedShadowFailClosed: ['closedShadowDomFailClosed'],
      },
      artifacts: [managedComplexArtifact('shadowDom')],
      readbacks: ['complexEvidence.shadowDom.businessReadback'],
    }],
  },
  {
    id: 't1-05-hover',
    title: 'Hover 由真实输入触发并以业务状态读回验证',
    bindings: [{
      proof: 'relay',
      assertions: ['hoverBusinessStateVerified'],
      artifacts: [screenshot('complexEvidence.hover.screenshot')],
      readbacks: ['complexEvidence.hover.businessReadback'],
    }],
  },
  {
    id: 't1-06-drag',
    title: 'Drag 使用真实输入并验证最终位置/顺序',
    bindings: [{
      proof: 'relay',
      assertions: ['dragBusinessStateVerified'],
      artifacts: [screenshot('complexEvidence.drag.screenshot')],
      readbacks: ['complexEvidence.drag.businessReadback'],
    }],
  },
  {
    id: 't1-07-clipboard-policy',
    title: 'Managed Clipboard 验证业务读回，Relay 权限边界明确 fail-closed',
    bindings: [
      {
        proof: 'managed',
        assertions: ['clipboardBusinessStateVerified'],
        assertionAliases: {
          clipboardBusinessStateVerified: ['managedClipboardBusinessReadbackVerified'],
        },
        artifacts: [managedComplexArtifact('clipboard')],
        readbacks: ['complexEvidence.clipboard.businessReadback'],
      },
      {
        proof: 'relay',
        assertions: ['relayClipboardFailClosed'],
        assertionAliases: {
          relayClipboardFailClosed: ['clipboardCapabilityUnsupported'],
        },
      },
    ],
    defer: {
      proof: 'relay',
      recordPaths: ['evidenceBackedDefers[]', 'defers.clipboard'],
      capability: 'relay_clipboard',
      fallback: 'managed',
      gate: 'G3',
    },
  },
  {
    id: 't1-08-dialog-policy',
    title: 'Dialog accept/dismiss policy 明确且页面结果可验证',
    bindings: [{
      proof: 'relay',
      assertions: ['dialogPolicyBusinessStateVerified'],
      artifacts: [screenshot('complexEvidence.dialog.screenshot')],
      readbacks: ['complexEvidence.dialog.businessReadback'],
    }],
  },
  {
    id: 't1-09-upload',
    title: 'Relay upload 显式批准、限定文件并验证业务结果',
    bindings: [{
      proof: 'relay',
      assertions: ['uploadApprovalAndBusinessStateVerified'],
      assertionAliases: {
        uploadApprovalAndBusinessStateVerified: ['exactFileUploadApprovedAndVerified'],
      },
      artifacts: [
        {
          recordPath: 'businessEvidence.upload',
          fileField: 'path',
        },
        screenshot('businessEvidence.screenshot'),
      ],
      readbacks: ['businessEvidence.upload.pageReadback'],
    }],
  },
  {
    id: 't1-10-download',
    title: 'Managed download 校验产物，Relay 无 cancel/cleanup 时明确 fail-closed',
    bindings: [
      {
        proof: 'managed',
        assertions: ['downloadArtifactAndBusinessStateVerified'],
        assertionAliases: {
          downloadArtifactAndBusinessStateVerified: ['managedDownloadBusinessReadbackVerified'],
        },
        artifacts: [screenshot('complexEvidence.download.artifact')],
        readbacks: ['complexEvidence.download.businessReadback'],
      },
      { proof: 'relay', assertions: ['relayDownloadFailClosed'] },
    ],
    defer: {
      proof: 'relay',
      recordPaths: ['evidenceBackedDefers[]', 'defers.download'],
      capability: 'relay_download',
      fallback: 'managed',
      gate: 'G3',
    },
  },
  {
    id: 't1-11-disconnect-restart-recovery',
    title: 'Relay 断线与进程重启都只读恢复并要求 fresh observation',
    bindings: [
      {
        proof: 'relay',
        assertions: ['disconnectOrphanedLease', 'orphanedMutationBlocked', 'orphanedTabReturned'],
      },
      {
        proof: 'durable',
        assertions: [
          'realProcessBoundary',
          'recoveredReadOnly',
          'oldGrantRevoked',
          'freshObservationRequired',
        ],
        artifacts: [screenshot('evidence.checkpoint')],
      },
    ],
  },
  {
    id: 't1-12-computer-foreground-background',
    title: 'Computer 前后台切换、输入锁恢复和跨 Surface 续跑可验证',
    bindings: [
      {
        proof: 'computer',
        assertions: [
          'foregroundObservationVerified',
          'backgroundFallbackVerified',
          'inputLockRecovered',
        ],
        artifacts: [screenshot('evidence.foregroundBackground.screenshot')],
        readbacks: ['evidence.foregroundBackground.businessReadback'],
      },
      {
        proof: 'crossSurface',
        assertions: [
          'surfaceSwitchReasonsRecorded',
          'browserContinuationBusinessReadback',
          'parentSessionLinked',
        ],
        artifacts: [
          screenshot('evidence.browser.beforeScreenshot'),
          screenshot('evidence.browser.afterScreenshot'),
        ],
        readbacks: ['evidence.browser.beforeReadback', 'evidence.browser.afterReadback'],
      },
    ],
  },
];

const workbuddyBinding: ProofBinding = {
  proof: 'workbuddy',
  assertions: [
    'draftScreenshotCapturedThisRun',
    'draftDomBusinessReadbackFailed',
    'failureJudgmentProjected',
    'artifactAdjustedAfterFailure',
    'finalScreenshotCapturedThisRun',
    'finalDomBusinessReadbackPassed',
    'finalPixelSuccessBannerVerified',
    'finalArtifactSaved',
  ],
  artifacts: [
    screenshot('stages.draft.screenshot'),
    screenshot('stages.final.screenshot'),
    {
      recordPath: 'stages.final',
      fileField: 'artifactPath',
      sha256Field: 'artifactSha256',
      bytesField: 'artifactBytes',
    },
  ],
  readbacks: ['stages.draft.businessJudgment', 'stages.final.businessJudgment'],
};

const conversationBinding: ProofBinding = {
  proof: 'conversation',
  assertions: [
    'session_header_target_provider_state',
    'semantic_timeline_business_phases',
    'screenshot_evidence_lifecycle',
    'screenshot_evidence_business_findings',
    'conversation_evidence_frame_pixels',
    'evidence_frozen_capture_context',
    'outputs_evidence_sources_separated',
    'owner_scoped_html_output_readback',
    'owner_scoped_png_output_pixels',
    'unknown_output_ref_fail_closed',
    'folded_turn_keeps_key_surface_resources',
    'unified_run_status_running',
    'pause_control_effect',
    'resume_control_effect',
    'takeover_control_and_card',
    'stop_control_effect',
    'end_session_terminal_state',
    'unified_run_status_terminal',
    'terminal_frame_and_outputs_readback',
    'control_sequence',
    'production_snapshot_invocation_chain',
    'production_frame_resolution_chain',
    'production_output_resolution_chain',
    'surface_sse_subscription_delivery',
    'runtime_session_store_domain_renderer_chain',
  ],
  artifacts: [{
    recordPath: 'businessEvidence.screenshot',
    fileField: 'file',
  }],
  readbacks: ['businessEvidence.deterministicInspection'],
};

export const SURFACE_COMPLETION_ROWS: CompletionRowDefinition[] = [
  {
    phase: 'P0',
    id: 'p0-a-contract-compatibility',
    title: 'Surface V1 合同、Browser/Computer 真路径与旧消息兼容',
    bindings: [{
      proof: 'crossSurface',
      assertions: ['surfaceContractRoutedBrowserAndComputer', 'legacyProjectionRemainsReadable'],
    }],
  },
  {
    phase: 'P0',
    id: 'p0-b-runtime-control-plane',
    title: 'Owner、Grant、Observation、控制与 successor verification',
    gateIds: [
      't0-06-cross-agent-session-isolation',
      't0-07-stale-target-fence',
      't0-08-pause-takeover-fence',
      't0-09-stop-cancel-fence',
    ],
  },
  {
    phase: 'P0',
    id: 'p0-c-browser-trust-boundary',
    title: 'Relay tab lease、协议、权限、真实输入与 cleanup',
    gateIds: [
      't0-01-unauthorized-read-write',
      't0-02-exact-tab-scope',
      't0-03-exact-domain-scope',
      't0-04-exact-action-scope',
      't0-05-exact-time-scope',
      't0-07-stale-target-fence',
      't0-10-cleanup-and-return',
      't0-11-protocol-version-mismatch',
    ],
  },
  {
    phase: 'P0',
    id: 'p0-d-conversation-execution-ux',
    title: '会话语义时间线、证据三态、控制、折叠与真实业务截图',
    bindings: [conversationBinding],
  },
  {
    phase: 'P0',
    id: 'p0-e-integrated-acceptance',
    title: 'T0 红线、受控登录态边界、真实 Computer、跨 Surface 与 WorkBuddy 主验收；外部登录站点待 G3',
    gateIds: SURFACE_T0_GATES.map((gate) => gate.id),
    bindings: [
      {
        proof: 'managed',
        assertions: ['managedAuthenticatedSessionVerified'],
        artifacts: [managedComplexArtifact('auth')],
        readbacks: ['complexEvidence.auth.businessReadback'],
      },
      {
        proof: 'relay',
        assertions: ['relayAuthenticatedSessionReused'],
        readbacks: ['authenticationEvidence.readback'],
      },
      workbuddyBinding,
      {
        proof: 'computer',
        assertions: [
          'realAppObserved',
          'realAppMutationDelivered',
          'realAppBusinessVerified',
          'takeoverBlockedMutation',
          'cleanupReleasedComputerLock',
        ],
        artifacts: [screenshot('evidence.businessVerification.screenshot')],
        readbacks: ['evidence.businessVerification.businessReadback'],
      },
    ],
    defer: {
      gate: 'G3',
      reason: 'Managed 与 Relay 已在真实 Chrome 运行时验证受控登录态隔离和授权 tab 复用，但当前没有用户授权的外部测试账号、OTP/MFA 协调或可复核的登录站点任务，不能把本地受控登录态 fixture 记作外部真实登录验收。',
      evidenceObserved: [
        'managed-proof:controlled-authenticated-session-isolated-profile-readback',
        'relay-proof:controlled-authenticated-session-reused-only-inside-explicit-tab-domain-action-time-scope',
        'computer-cross-surface-workbuddy-real-runtime-business-verification-passed',
      ],
      evidenceRequired: [
        'user-authorized-external-test-account-or-public-login-sandbox',
        'real-Managed-login-observe-act-verify-cleanup-E2E',
        'real-Relay-login-state-reuse-with-exact-tab-domain-action-time-scope-and-tab-return',
        'OTP-MFA-and-account-recovery-operator-evidence-if-the-selected-site-requires-it',
      ],
    },
  },
  {
    phase: 'P1',
    id: 'p1-browser-complex-targets-input',
    title: 'iframe/Shadow/hover/drag/clipboard/dialog 已验证；跨站 OOPIF 执行待 G3',
    gateIds: SURFACE_T1_GATES.slice(1, 8).map((gate) => gate.id),
    defer: {
      gate: 'G3',
      reason: '当前 Managed provider 对跨站 OOPIF 明确 fail-closed，但还没有为目标 frame 建立专用 CDP session，因此不能把安全阻断记作跨站 OOPIF 执行完成。',
      evidenceObserved: [
        'managed-proof:oopifRequiresDedicatedSessionFailClosed',
        'managed-proof:cross-site-frame-is-rejected-before-input',
        'controlled-complex-proof:iframe-shadow-hover-drag-clipboard-dialog-business-readbacks-pass',
      ],
      evidenceRequired: [
        'dedicated-CDP-session-owned-by-the-exact-OOPIF-target',
        'real-cross-site-OOPIF-observe-act-verify-E2E',
        'navigation-reorder-stale-ref-and-cleanup-adversarial-coverage',
      ],
    },
  },
  {
    phase: 'P1',
    id: 'p1-relay-artifact-parity',
    title: 'Relay console/network、真实 screenshot、upload/download parity',
    gateIds: ['t1-09-upload', 't1-10-download'],
    bindings: [{
      proof: 'relay',
      assertions: ['consoleNetworkCursor', 'screenshotCaptured'],
      artifacts: [screenshot('businessEvidence.screenshot')],
      readbacks: ['businessEvidence.expectedReadback'],
    }],
  },
  {
    phase: 'P1',
    id: 'p1-router-and-three-session-control',
    title: 'Router 决策与三个并行 Session 独立暂停/停止',
    bindings: [
      {
        proof: 'managed',
        assertions: [
          'routerCapabilityOwnershipIntentVerified',
          'threeConcurrentSessions',
          'isolatedBrowserIdentities',
          'independentPause',
          'noPostStopMutation',
        ],
      },
      { proof: 'relay', assertions: ['agentWindowIsolation'] },
    ],
  },
  {
    phase: 'P1',
    id: 'p1-computer-and-cross-surface-recovery',
    title: 'Computer 前后台、输入锁与 Browser/Computer 自动切换',
    gateIds: ['t1-12-computer-foreground-background'],
    bindings: [{
      proof: 'conversation',
      assertions: ['cross_surface_switch_reason_displayed'],
    }],
  },
  {
    phase: 'P1',
    id: 'p1-pairing-doctor-protocol-upgrade',
    title: 'Pairing、doctor 与协议偏差已验证；真实版本升级待 G3',
    bindings: [{
      proof: 'relay',
      assertions: [
        'pairingFlowVerified',
        'doctorStatusVerified',
        'protocolVersionMismatchBlocked',
      ],
    }],
    defer: {
      gate: 'G3',
      reason: '当前运行只加载本 worktree 的 unpacked 扩展，没有一个可复核的上一版本安装包和升级前持久状态，因此不能把当前版本启动与协议拒绝记作升级兼容验证。',
      evidenceObserved: [
        'relay-proof:current-unpacked-extension-pairing-flow-verified',
        'relay-proof:doctor-status-verified',
        'relay-proof:protocol-version-mismatch-fails-closed',
      ],
      evidenceRequired: [
        'immutable-previous-version-extension-bundle-with-source-fingerprint',
        'previous-to-current-reload-upgrade-with-pairing-and-lease-state-migration',
        'upgrade-rollback-protocol-mismatch-and-tab-return-E2E',
      ],
    },
  },
  {
    phase: 'P1',
    id: 'p1-extension-store-signing',
    title: '扩展商店签名与发布验证',
    bindings: [{
      proof: 'relay',
      assertions: [
        'pairingFlowVerified',
        'doctorStatusVerified',
        'protocolVersionMismatchBlocked',
      ],
    }],
    defer: {
      gate: 'G3',
      reason: '商店签名和提交需要用户发布授权；本 Goal 明确禁止未经授权提交扩展商店。',
      evidenceObserved: [
        'truth-source:section-24.9-store-submission-requires-explicit-authorization',
        'relay-proof:pairing-doctor-and-current-protocol-compatibility-verified',
        'repository:extension-remains-an-unsubmitted-unpacked-bundle',
      ],
      evidenceRequired: [
        '用户明确发布授权',
        '商店签名产物和签名身份',
        '安装、升级、回滚与协议兼容 E2E',
      ],
    },
  },
  {
    phase: 'P1',
    id: 'p1-before-after-proof-and-durable-recovery',
    title: 'before/after 检查清单、SurfaceProofService 与 durable continuation',
    bindings: [
      workbuddyBinding,
      {
        proof: 'workbuddy',
        assertions: ['sharedSurfaceProofCardsPresent', 'beforeAfterScreenshotsDiffer'],
      },
      {
        proof: 'durable',
        assertions: [
          'realProcessBoundary',
          'ledgerPersisted',
          'recoveredReadOnly',
          'onlyExplicitContinueAvailable',
          'continuationOwnerScoped',
          'continuationSingleUse',
          'parentSessionLinked',
          'freshObservationRequired',
          'cleanupCompleted',
        ],
        artifacts: [screenshot('evidence.checkpoint')],
      },
    ],
  },
  {
    phase: 'P2',
    id: 'p2-external-agent-adapters',
    title: '外部 Agent authority seam 已验证；生产入口激活待 G4',
    bindings: [{
      proof: 'durable',
      assertions: ['externalSurfaceAdapterContractVerified'],
    }],
    defer: {
      gate: 'G4',
      reason: '内部 authority fence 已实现，但仓内没有认证 transport、Host-owned bootstrap 或可调用的 neo surface / neo browser 生产入口；未经 consumer 与公开合同决策不能安全激活。',
      evidenceObserved: [
        'durable-proof:p2Acceptance.assertions.externalSurfaceAdapterContractVerified',
        'repository-audit:no-production-ExternalSurfaceAgentAdapter-registration',
        'repository-audit:existing-providers-remain-the-single-runtime-owner',
      ],
      evidenceRequired: [
        'approved-external-consumer-and-authentication-contract',
        'host-owned-run-session-provider-bootstrap',
        'real-provider-entrypoint-e2e-with-cleanup-and-redaction',
      ],
    },
  },
  {
    phase: 'P2',
    id: 'p2-organization-policy-audit-retention',
    title: '组织策略引擎 seam 已验证；生产 provider 执行、持久配置与管理入口待 G4',
    bindings: [{
      proof: 'durable',
      assertions: ['organizationPolicyAuditRetentionVerified'],
    }],
    defer: {
      gate: 'G4',
      reason: 'deny-by-default、审批、redacted audit 与 TTL 已通过 ExternalSurfaceAgentAdapter 和 P2 acceptance seam 验证；Managed、Relay、Computer 的 production bootstrap/enforcement 尚未接入，默认 audit store 也仍是进程内实现。',
      evidenceObserved: [
        'durable-proof:p2Acceptance.assertions.organizationPolicyAuditRetentionVerified',
        'repository:policy-enforcement-is-invoked-by-ExternalSurfaceAgentAdapter-and-acceptance-seam-only',
        'repository:Managed-Relay-Computer-production-policy-bootstrap-and-enforcement-absent',
        'repository:InMemorySurfaceOrganizationAuditStore-is-default',
        'p2-proof:profile-and-account-omission-fail-closed',
      ],
      evidenceRequired: [
        'host-owned-organization-identity-and-policy-bootstrap-for-Managed-Relay-Computer',
        'real-Managed-Relay-Computer-provider-policy-enforcement-E2E',
        'organization-admin-contract',
        'persistent-audit-store-and-migration',
        'retention-access-control-and-deletion-e2e',
      ],
    },
  },
  {
    phase: 'P2',
    id: 'p2-replay-and-failure-reproduction',
    title: '跨进程语义 replay 已验证；可携带截图资产包待 G4',
    bindings: [
      workbuddyBinding,
      {
        proof: 'durable',
        assertions: [
          'freshProcessReplayBoundary',
          'isolatedReplayDataDirectory',
          'importedIntoIsolatedStore',
          'conversationRebound',
          'archiveProjectionReadOnly',
          'grantNone',
          'noTarget',
          'noControls',
          'runtimeMutationCallsZero',
          'replayExplicitSurfaceEvents',
          'failureAdjustPassReproduced',
          'semanticDigestMatched',
          'rawCanaryAbsent',
          'portableScreenshotEvidenceMetadataOnly',
        ],
        artifacts: [{
          recordPath: 'evidence.replayImport',
          fileField: 'path',
          sha256Field: 'sha256',
          bytesField: 'bytes',
        }],
        readbacks: ['evidence.replayImport.businessReadback'],
      },
    ],
    defer: {
      gate: 'G4',
      reason: 'safe export 与 fresh-process replay 已复现失败、调整和复验语义，同时故意移除了 assetRef/path/bytes；当前没有可跨会话携带并重新验真的截图资产包。',
      evidenceObserved: [
        'durable-proof:fresh-process-import-isolated-read-only-and-authority-free',
        'durable-proof:source-and-replay-semantic-digests-match',
        'durable-proof:screenshot-evidence-is-metadata-only-and-raw-paths-absent',
      ],
      evidenceRequired: [
        'redacted-portable-evidence-bundle-manifest-with-hash-and-byte-length',
        'fresh-process-screenshot-asset-readback-and-business-reverification',
        'missing-tampered-and-expired-asset-fail-closed-coverage',
      ],
    },
  },
  {
    phase: 'P2',
    id: 'p2-windows-linux-provider',
    title: 'Windows/Linux profile import 与 Computer provider',
    bindings: [{
      proof: 'durable',
      assertions: ['providerNeutralRegistryContractVerified'],
    }],
    defer: {
      gate: 'G4',
      reason: '当前验收主机只有 macOS；跨平台 provider 需要对应系统、签名 helper 和真实权限环境。',
      evidenceObserved: [
        'computer-proof:current-host-platform-darwin',
        'repository:no-approved-windows-linux-provider-or-helper',
        'truth-source:G4-cross-platform-provider-decision',
      ],
      evidenceRequired: [
        'Windows 与 Linux 专用验收主机',
        '各平台签名 helper/version/codesign 等价证据',
        'observe/mutate/verify/takeover/cleanup 真实 E2E',
      ],
    },
  },
  {
    phase: 'P2',
    id: 'p2-provider-neutral-registry',
    title: 'Provider-neutral registry seam 已验证；多浏览器、remote Managed、mobile 与 in-app 实现待 G4',
    bindings: [{
      proof: 'durable',
      assertions: [
        'providerNeutralRegistryContractVerified',
        'providerImplementationDefersExact',
      ],
      readbacks: ['p2Acceptance.evidenceBackedDefers.providerImplementations[]'],
    }],
    defer: {
      gate: 'G4',
      reason: 'Provider-neutral registration、capability selection、ownership fence 与 gated provider 拒绝路径已验证；五类 future provider 仍只有注册合同和逐项 G4 决策记录，没有可运行实现或真实环境 E2E。',
      evidenceObserved: [
        'durable-proof:p2Acceptance.assertions.providerNeutralRegistryContractVerified',
        'durable-proof:p2Acceptance.evidenceBackedDefers.providerImplementations-records',
        'p2-proof:future-provider-resolution-fails-with-provider-gate-pending',
      ],
      evidenceRequired: [
        'per-provider-demand-success-latency-cost-and-isolation-decision-evidence',
        'approved-provider-implementation-with-host-owned-authority-and-cleanup',
        'real-provider-observe-mutate-verify-recovery-redaction-E2E',
      ],
    },
  },
  {
    phase: 'P2',
    id: 'p2-continuous-real-site-app-regression',
    title: '代表性 Surface 主链已验证；T2 真实站点与应用连续回归基线待 G4',
    bindings: [
      {
        proof: 'managed',
        assertions: ['threeConcurrentSessions', 'businessReadback', 'managedAuthenticatedSessionVerified'],
        artifacts: [{
          recordPath: 'evidence[]',
          fileField: 'screenshotPath',
          sha256Field: 'screenshotSha256',
          bytesField: 'screenshotBytes',
          minCount: 3,
        }],
        readbacks: ['evidence[].businessReadback', 'complexEvidence.auth.businessReadback'],
      },
      {
        proof: 'relay',
        assertions: ['businessReadback', 'relayAuthenticatedSessionReused'],
        artifacts: [screenshot('businessEvidence.screenshot')],
        readbacks: ['businessEvidence.expectedReadback', 'authenticationEvidence.readback'],
      },
      {
        proof: 'computer',
        assertions: ['realAppBusinessVerified', 'backgroundFallbackVerified'],
        artifacts: [
          screenshot('evidence.businessVerification.screenshot'),
          screenshot('evidence.foregroundBackground.screenshot'),
        ],
        readbacks: [
          'evidence.businessVerification.businessReadback',
          'evidence.foregroundBackground.businessReadback',
        ],
      },
      {
        proof: 'crossSurface',
        assertions: [
          'realComputerBusinessVerified',
          'browserContinuationBusinessReadback',
          'surfaceSwitchReasonsRecorded',
        ],
        artifacts: [
          screenshot('evidence.browser.beforeScreenshot'),
          screenshot('evidence.browser.afterScreenshot'),
        ],
        readbacks: ['evidence.browser.beforeReadback', 'evidence.browser.afterReadback'],
      },
      workbuddyBinding,
    ],
    defer: {
      gate: 'G4',
      reason: 'Managed、Relay、Computer、跨 Surface 与 WorkBuddy 的代表性真实运行链已覆盖；T2 仍缺 12 个带登录态的真实站点/应用任务、OTP/MFA 协调、CI Computer 权限主机和连续指标样本，不能由受控 fixture 外推生产成功率。',
      evidenceObserved: [
        'managed-proof:three-isolated-sessions-controlled-auth-readback-and-screenshots',
        'relay-proof:explicit-tab-lease-controlled-auth-session-readback-and-tab-return',
        'computer-proof:real-app-foreground-background-mutation-and-business-readback',
        'cross-surface-proof:Browser-Computer-Browser-business-continuation',
        'workbuddy-proof:generate-open-inspect-judge-adjust-reverify-artifact',
      ],
      evidenceRequired: [
        'T2-12-credentialed-real-site-and-real-app-task-corpus',
        'OTP-MFA-and-account-recovery-operator-protocol',
        'CI-Computer-host-with-real-accessibility-and-screen-recording-permissions',
        'real-task-success-rate-at-least-85-percent-or-15pp-over-baseline',
        'controlled-task-success-rate-at-least-95-percent',
        'recovery-success-rate-at-least-90-percent',
        'human-status-recognition-within-5-seconds-at-least-90-percent',
      ],
    },
  },
  {
    phase: 'P2',
    id: 'p2-remote-pool-device-cloud',
    title: 'Remote browser pool 与设备云投入决策',
    bindings: [{
      proof: 'durable',
      assertions: ['providerNeutralRegistryContractVerified'],
    }],
    defer: {
      gate: 'G4',
      reason: '方案要求依据真实使用量和 benchmark 决策，当前不得在没有需求与成本证据时扩大产品范围。',
      evidenceObserved: [
        'p2-proof:future-providers-fail-closed-with-provider-gate-pending',
        'provider-registry:G4-decisions-require-demand-latency-cost-and-isolation-evidence',
        'truth-source:section-16-investment-follows-real-usage-and-benchmark',
      ],
      evidenceRequired: [
        '真实 Browser/Computer 使用量与并发分布',
        '本地和远程 provider 成功率、p95、恢复率 benchmark',
        '设备云成本、数据驻留、账号隔离与退出方案',
      ],
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valuesAtPath(value: unknown, path: string): unknown[] {
  return path.split('.').reduce<unknown[]>((current, rawSegment) => {
    const arraySegment = rawSegment.endsWith('[]');
    const segment = arraySegment ? rawSegment.slice(0, -2) : rawSegment;
    const next = current.flatMap((candidate) => {
      if (!isRecord(candidate) || !(segment in candidate)) return [];
      return [candidate[segment]];
    });
    return arraySegment ? next.flatMap((candidate) => (Array.isArray(candidate) ? candidate : [])) : next;
  }, [value]);
}

function readAssertion(document: unknown, key: string): boolean | undefined {
  if (!isRecord(document)) return undefined;
  const assertions = document.assertions;
  if (isRecord(assertions)) {
    return typeof assertions[key] === 'boolean' ? assertions[key] : undefined;
  }
  if (!Array.isArray(assertions)) return undefined;
  const match = assertions.find((candidate) => isRecord(candidate) && candidate.id === key);
  return isRecord(match) && typeof match.passed === 'boolean' ? match.passed : undefined;
}

function hasAssertion(document: unknown, key: string): boolean {
  if (!isRecord(document)) return false;
  const assertions = document.assertions;
  if (isRecord(assertions)) return Object.hasOwn(assertions, key);
  return Array.isArray(assertions)
    && assertions.some((candidate) => isRecord(candidate) && candidate.id === key);
}

function sourceFingerprintMatches(
  recorded: unknown,
  current: SurfaceAcceptanceSourceFingerprintV1,
): boolean {
  if (!isRecord(recorded)) return false;
  return recorded.version === current.version
    && recorded.algorithm === current.algorithm
    && recorded.sha256 === current.sha256
    && recorded.head === current.head
    && recorded.dirty === current.dirty
    && JSON.stringify(recorded.dirtyPaths) === JSON.stringify(current.dirtyPaths)
    && JSON.stringify(recorded.scopes) === JSON.stringify(current.scopes);
}

function externalComputerBlock(id: SurfaceGateProofId, document: unknown): boolean {
  if ((id !== 'computer' && id !== 'crossSurface') || !isRecord(document)) return false;
  if (document.status !== 'blocked') return false;
  const expectedStage = id === 'computer' ? 'permissions' : 'computer-permission';
  if (document.stage !== expectedStage) return false;
  const failure = id === 'computer' ? document.failure : document.externalBlock;
  return isRecord(failure)
    && failure.code === 'COMPUTER_PERMISSION_REQUIRED'
    && failure.userActionRequired === true
    && Array.isArray(failure.missing)
    && failure.missing.length > 0;
}

const CAMPAIGN_CLOCK_SKEW_TOLERANCE_MS = 2_000;

function campaignFreshnessIssues(
  proof: LoadedSurfaceProof,
  document: Record<string, unknown>,
  expected: SurfaceAcceptanceCampaignV1,
  reportGeneratedAt: string,
): string[] {
  const issues: string[] = [];
  const recorded = document.campaign;
  if (!isRecord(recorded)
    || recorded.id !== expected.id
    || recorded.startedAt !== expected.startedAt
    || Object.keys(recorded).sort().join(',') !== 'id,startedAt') {
    issues.push('proof campaign does not exactly match the requested acceptance campaign');
  }

  const campaignStartMs = Date.parse(expected.startedAt);
  const reportGeneratedAtMs = Date.parse(reportGeneratedAt);
  const latestAcceptedMs = reportGeneratedAtMs + CAMPAIGN_CLOCK_SKEW_TOLERANCE_MS;
  if (!Number.isFinite(reportGeneratedAtMs)
    || new Date(reportGeneratedAtMs).toISOString() !== reportGeneratedAt) {
    issues.push('gate report generatedAt must be a canonical UTC ISO timestamp');
  }
  const timestampFields = ['recordedAt', 'startedAt', 'finishedAt'] as const;
  const presentFields = timestampFields.filter((field) => Object.hasOwn(document, field));
  if (presentFields.length === 0) {
    issues.push('proof root is missing recordedAt, startedAt, or finishedAt campaign timing');
  }
  for (const field of presentFields) {
    const value = document[field];
    if (typeof value !== 'string') {
      issues.push(`proof ${field} must be a canonical UTC ISO timestamp`);
      continue;
    }
    const timestampMs = Date.parse(value);
    if (!Number.isFinite(timestampMs) || new Date(timestampMs).toISOString() !== value) {
      issues.push(`proof ${field} must be a canonical UTC ISO timestamp`);
      continue;
    }
    if (timestampMs < campaignStartMs) {
      issues.push(`proof ${field} predates the requested acceptance campaign`);
    }
    if (Number.isFinite(reportGeneratedAtMs) && timestampMs > latestAcceptedMs) {
      issues.push(`proof ${field} is later than gate report generatedAt beyond clock-skew tolerance`);
    }
  }

  const checkFileMtime = (label: string, mtimeMs: number | undefined): void => {
    if (!Number.isFinite(mtimeMs)) {
      issues.push(`${label} mtime is missing from loaded proof evidence`);
      return;
    }
    if ((mtimeMs as number) < campaignStartMs) {
      issues.push(`${label} mtime predates the requested acceptance campaign`);
    }
    if (Number.isFinite(reportGeneratedAtMs) && (mtimeMs as number) > latestAcceptedMs) {
      issues.push(`${label} mtime is later than gate report generatedAt beyond clock-skew tolerance`);
    }
  };
  checkFileMtime('proof file', proof.proofFileMtimeMs);
  for (const [requirement, facts] of Object.entries(proof.artifactFacts || {})) {
    facts.forEach((fact, index) => {
      if (fact.exists) checkFileMtime(`artifact ${requirement}[${index}]`, fact.mtimeMs);
    });
  }
  return issues;
}

function rank(status: SurfaceGateStatus): number {
  return ({
    passed: 0,
    evidence_backed_defer: 0,
    blocked_external: 1,
    missing: 2,
    stale: 3,
    failed: 4,
  } satisfies Record<SurfaceGateStatus, number>)[status];
}

function worstStatus<T extends SurfaceGateStatus>(statuses: T[], fallback: T): T {
  if (statuses.length === 0) return fallback;
  return statuses.slice(1).reduce(
    (worst, status) => (
      rank(status) > rank(worst)
        || (rank(status) === rank(worst) && status === 'evidence_backed_defer')
        ? status
        : worst
    ),
    statuses[0],
  );
}

function inspectProof(
  proof: LoadedSurfaceProof | undefined,
  id: SurfaceGateProofId,
  current: SurfaceAcceptanceSourceFingerprintV1,
  campaign?: SurfaceAcceptanceCampaignV1,
  reportGeneratedAt = new Date(0).toISOString(),
): ProofInventoryResult {
  const path = proof?.path || SURFACE_GATE_PROOF_PATHS[id];
  if (!proof?.document) {
    return { id, path, status: 'missing', issues: [proof?.loadError || 'proof file is missing'] };
  }
  if (!isRecord(proof.document)) {
    return { id, path, status: 'failed', issues: ['proof JSON root must be an object'] };
  }
  const recordedStatus = typeof proof.document.status === 'string'
    ? proof.document.status
    : undefined;
  if (!sourceFingerprintMatches(proof.document.sourceFingerprint, current)) {
    return {
      id,
      path,
      status: 'stale',
      recordedStatus,
      issues: ['sourceFingerprint does not exactly match the current Surface acceptance source'],
    };
  }
  if (campaign) {
    const issues = campaignFreshnessIssues(proof, proof.document, campaign, reportGeneratedAt);
    if (issues.length > 0) {
      return {
        id,
        path,
        status: 'stale',
        recordedStatus,
        issues,
      };
    }
  }
  if (externalComputerBlock(id, proof.document)) {
    return {
      id,
      path,
      status: 'blocked_external',
      recordedStatus,
      issues: ['real Computer system permission is required before mutation'],
    };
  }
  if (recordedStatus !== 'passed') {
    return {
      id,
      path,
      status: 'failed',
      recordedStatus,
      issues: [`proof status must be passed; recorded ${recordedStatus || 'missing'}`],
    };
  }
  return { id, path, status: 'passed', recordedStatus, issues: [] };
}

export function artifactRequirementKey(requirement: ArtifactRequirement): string {
  return JSON.stringify({
    recordPath: requirement.recordPath,
    fileField: requirement.fileField || 'path',
    sha256Field: requirement.sha256Field || 'sha256',
    bytesField: requirement.bytesField || 'bytes',
  });
}

function artifactIssues(
  proof: LoadedSurfaceProof,
  requirement: ArtifactRequirement,
): { status: 'passed' | 'failed' | 'missing'; issues: string[] } {
  const facts = proof.artifactFacts?.[artifactRequirementKey(requirement)] || [];
  const minCount = requirement.minCount ?? 1;
  if (facts.length < minCount) {
    return {
      status: 'missing',
      issues: [`${requirement.recordPath} requires ${minCount} artifact record(s), found ${facts.length}`],
    };
  }
  const issues: string[] = [];
  let missing = false;
  facts.forEach((fact, index) => {
    const prefix = `${requirement.recordPath}[${index}]`;
    if (!fact.declaredPath
      || !fact.expectedSha256?.match(/^[a-f0-9]{64}$/)
      || typeof fact.expectedBytes !== 'number'
      || !Number.isInteger(fact.expectedBytes)
      || fact.expectedBytes <= 0) {
      missing = true;
      issues.push(`${prefix} is missing file path, lowercase sha256, or positive integer bytes metadata`);
    }
    if (!fact.insideProofDirectory) {
      issues.push(`${prefix} resolves outside its canonical proof directory`);
    }
    if (!fact.exists) {
      missing = true;
      issues.push(`${prefix} artifact file does not exist`);
    }
    if (fact.readError) issues.push(`${prefix} could not be read: ${fact.readError}`);
    if (fact.exists && fact.expectedBytes !== fact.actualBytes) {
      issues.push(`${prefix} byte count does not match the artifact file`);
    }
    if (fact.exists && fact.expectedSha256 !== fact.actualSha256) {
      issues.push(`${prefix} sha256 does not match the artifact file`);
    }
  });
  if (issues.length === 0) return { status: 'passed', issues };
  return { status: missing ? 'missing' : 'failed', issues };
}

function hasReadback(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (value === true) return true;
  if (Array.isArray(value)) return value.length > 0;
  return isRecord(value) && Object.keys(value).length > 0;
}

function evaluateBinding(
  binding: ProofBinding,
  proofs: Partial<Record<SurfaceGateProofId, LoadedSurfaceProof>>,
  inventory: Map<SurfaceGateProofId, ProofInventoryResult>,
): BindingEvaluation {
  const proof = proofs[binding.proof];
  const proofState = inventory.get(binding.proof);
  const result: BindingEvaluation = {
    proof: binding.proof,
    proofPath: proofState?.path || SURFACE_GATE_PROOF_PATHS[binding.proof],
    assertionKeys: [...binding.assertions],
    assertionCandidates: Object.fromEntries(binding.assertions.map((assertion) => [
      assertion,
      [assertion, ...(binding.assertionAliases?.[assertion] || [])],
    ])),
    resolvedAssertionKeys: [],
    artifactRecordPaths: (binding.artifacts || []).map((item) => item.recordPath),
    readbackPaths: [...(binding.readbacks || [])],
    status: proofState?.status || 'missing',
    issues: [...(proofState?.issues || ['proof inventory entry is missing'])],
  };
  if (result.status !== 'passed' || !proof?.document) return result;

  const statuses: Array<'passed' | 'failed' | 'missing'> = ['passed'];
  for (const assertion of binding.assertions) {
    const candidates = result.assertionCandidates[assertion];
    const canonicalValue = readAssertion(proof.document, assertion);
    if (hasAssertion(proof.document, assertion)) {
      if (canonicalValue === true) {
        result.resolvedAssertionKeys.push(assertion);
      } else if (canonicalValue === false) {
        statuses.push('failed');
        result.issues.push(
          'canonical assertion ' + assertion + ' is false; legacy aliases are ignored',
        );
      } else {
        statuses.push('missing');
        result.issues.push(
          'canonical assertion ' + assertion
            + ' is present but not boolean; legacy aliases are ignored',
        );
      }
      continue;
    }
    const values = candidates.slice(1).map((candidate) => ({
      candidate,
      value: readAssertion(proof.document, candidate),
    }));
    const passed = values.find((candidate) => candidate.value === true);
    if (passed) {
      result.resolvedAssertionKeys.push(passed.candidate);
    } else if (values.every((candidate) => candidate.value === undefined)) {
      statuses.push('missing');
      result.issues.push(`assertion candidates ${candidates.join(', ')} are missing or not boolean`);
    } else {
      statuses.push('failed');
      result.issues.push(`assertion candidates ${candidates.join(', ')} do not contain true`);
    }
  }
  for (const requirement of binding.artifacts || []) {
    const inspected = artifactIssues(proof, requirement);
    statuses.push(inspected.status);
    result.issues.push(...inspected.issues);
  }
  for (const path of binding.readbacks || []) {
    const values = valuesAtPath(proof.document, path);
    if (values.length === 0 || values.some((value) => !hasReadback(value))) {
      statuses.push('missing');
      result.issues.push(`${path} is missing an explicit business readback`);
    }
  }
  result.status = worstStatus(statuses, 'passed');
  return result;
}

function evaluateGateDefer(
  requirement: ProofDeferRequirement,
  proofs: Partial<Record<SurfaceGateProofId, LoadedSurfaceProof>>,
  inventory: Map<SurfaceGateProofId, ProofInventoryResult>,
): NonNullable<GateEvaluation['deferEvidence']> {
  const proof = proofs[requirement.proof];
  const proofState = inventory.get(requirement.proof);
  const result: NonNullable<GateEvaluation['deferEvidence']> = {
    proof: requirement.proof,
    proofPath: proofState?.path || SURFACE_GATE_PROOF_PATHS[requirement.proof],
    recordPaths: [...requirement.recordPaths],
    status: proofState?.status || 'missing',
    issues: [...(proofState?.issues || ['proof inventory entry is missing'])],
  };
  if (result.status !== 'passed' || !proof?.document) return result;
  const records = requirement.recordPaths
    .flatMap((path) => valuesAtPath(proof.document, path))
    .filter(isRecord);
  const record = records.find((candidate) => (
    !requirement.capability || candidate.capability === requirement.capability
  ));
  if (!record) {
    result.status = 'missing';
    result.issues.push(`defer metadata for ${requirement.capability || 'gate'} is missing`);
    return result;
  }
  const evidenceRequired = Array.isArray(record.evidenceRequired)
    ? record.evidenceRequired.filter((item): item is string => typeof item === 'string')
    : [];
  const defer = {
    gate: typeof record.gate === 'string' ? record.gate : '',
    reason: typeof record.reason === 'string' ? record.reason : '',
    evidenceObserved: Array.isArray(record.evidenceObserved)
      ? record.evidenceObserved.filter((item): item is string => typeof item === 'string')
      : [],
    evidenceRequired,
    fallback: record.fallback === 'managed' ? 'managed' as const : 'managed' as const,
    capability: typeof record.capability === 'string' ? record.capability : undefined,
  };
  result.defer = defer;
  if (record.status !== 'evidence-backed-defer' && record.status !== 'evidence_backed_defer') {
    result.issues.push('defer status must be evidence-backed-defer');
  }
  if (record.fallback !== requirement.fallback) {
    result.issues.push(`defer fallback must be ${requirement.fallback}`);
  }
  if (record.gate !== requirement.gate) {
    result.issues.push(`defer gate must be ${requirement.gate}`);
  }
  result.issues.push(...validateEvidenceBackedDefer(defer));
  result.status = result.issues.length === 0 ? 'evidence_backed_defer' : 'failed';
  return result;
}

function evaluateGate(
  gate: SurfaceGateDefinition,
  proofs: Partial<Record<SurfaceGateProofId, LoadedSurfaceProof>>,
  inventory: Map<SurfaceGateProofId, ProofInventoryResult>,
): GateEvaluation {
  const evidence = gate.bindings.map((binding) => evaluateBinding(binding, proofs, inventory));
  const evidenceStatus = worstStatus(evidence.map((item) => item.status), 'missing');
  const deferEvidence = gate.defer
    ? evaluateGateDefer(gate.defer, proofs, inventory)
    : undefined;
  return {
    id: gate.id,
    title: gate.title,
    status: evidenceStatus === 'passed' && deferEvidence
      ? deferEvidence.status
      : evidenceStatus,
    evidence,
    ...(deferEvidence ? { deferEvidence } : {}),
  };
}

export function validateEvidenceBackedDefer(defer: EvidenceBackedDefer): string[] {
  const issues: string[] = [];
  if (defer.gate !== 'G3' && defer.gate !== 'G4') {
    issues.push('evidence-backed defer is only allowed for an explicit G3 or G4 item');
  }
  if (!defer.reason.trim()) issues.push('evidence-backed defer requires a reason');
  if (defer.evidenceObserved.length === 0
    || defer.evidenceObserved.some((item) => !item.trim())) {
    issues.push('evidence-backed defer requires non-empty evidenceObserved entries');
  }
  if (defer.evidenceRequired.length === 0
    || defer.evidenceRequired.some((item) => !item.trim())) {
    issues.push('evidence-backed defer requires non-empty evidenceRequired entries');
  }
  return issues;
}

function evaluateCompletionRow(
  row: CompletionRowDefinition,
  gates: Map<string, GateEvaluation>,
  proofs: Partial<Record<SurfaceGateProofId, LoadedSurfaceProof>>,
  inventory: Map<SurfaceGateProofId, ProofInventoryResult>,
): CompletionRowEvaluation {
  const issues: string[] = [];
  const statuses: SurfaceGateStatus[] = [];
  const gateDefers: CompletionRowEvaluation['gateDefers'] = [];
  for (const gateId of row.gateIds || []) {
    const gate = gates.get(gateId);
    if (!gate) {
      statuses.push('missing');
      issues.push(`gate ${gateId} is missing`);
    } else {
      statuses.push(gate.status);
      if (gate.deferEvidence) {
        gateDefers.push({
          gateId,
          gateTitle: gate.title,
          ...gate.deferEvidence,
        });
      }
    }
  }
  const evidence = (row.bindings || []).map((binding) => evaluateBinding(binding, proofs, inventory));
  statuses.push(...evidence.map((item) => item.status));
  if (row.defer) {
    const deferIssues = validateEvidenceBackedDefer(row.defer);
    issues.push(...deferIssues);
    if (statuses.length === 0) {
      issues.push('evidence-backed defer requires at least one gate or proof binding');
    } else if (statuses.some((status) => (
      status !== 'passed' && status !== 'evidence_backed_defer'
    ))) {
      issues.push(
        'evidence-backed defer requires every gate and proof binding to pass or carry a valid evidence-backed defer',
      );
    }
    const verifiedImplementedEvidence = statuses.length > 0
      && statuses.every((status) => (
        status === 'passed' || status === 'evidence_backed_defer'
      ));
    const implementedStatus = statuses.length === 0
      ? 'failed'
      : worstStatus(statuses, 'failed');
    return {
      phase: row.phase,
      id: row.id,
      title: row.title,
      status: verifiedImplementedEvidence && deferIssues.length === 0
        ? 'evidence_backed_defer'
        : worstStatus([
            implementedStatus,
            ...(!verifiedImplementedEvidence || deferIssues.length > 0
              ? ['failed' as const]
              : []),
          ], 'failed'),
      gateIds: [...(row.gateIds || [])],
      evidence,
      gateDefers,
      defer: row.defer,
      issues,
    };
  }
  if (statuses.length === 0) {
    statuses.push('failed');
    issues.push('completion row has no gate, proof binding, or valid defer');
  }
  return {
    phase: row.phase,
    id: row.id,
    title: row.title,
    status: worstStatus(statuses, 'failed'),
    gateIds: [...(row.gateIds || [])],
    evidence,
    gateDefers,
    issues,
  };
}

export function evaluateSurfaceGateReport(input: SurfaceGateEvaluationInput): SurfaceGateReport {
  const proofInventory = (Object.keys(SURFACE_GATE_PROOF_PATHS) as SurfaceGateProofId[])
    .map((id) => inspectProof(
      input.proofs[id],
      id,
      input.currentSourceFingerprint,
      input.campaign,
      input.generatedAt,
    ));
  const inventory = new Map(proofInventory.map((item) => [item.id, item]));
  const t0 = (input.t0 || SURFACE_T0_GATES)
    .map((gate) => evaluateGate(gate, input.proofs, inventory));
  const t1 = (input.t1 || SURFACE_T1_GATES)
    .map((gate) => evaluateGate(gate, input.proofs, inventory));
  const gates = new Map([...t0, ...t1].map((gate) => [gate.id, gate]));
  const completionRows = (input.completionRows || SURFACE_COMPLETION_ROWS)
    .map((row) => evaluateCompletionRow(row, gates, input.proofs, inventory));
  const completion = {
    P0: completionRows.filter((row) => row.phase === 'P0'),
    P1: completionRows.filter((row) => row.phase === 'P1'),
    P2: completionRows.filter((row) => row.phase === 'P2'),
  };
  const allStatuses: SurfaceGateStatus[] = [
    ...proofInventory.map((item) => item.status),
    ...t0.map((item) => item.status),
    ...t1.map((item) => item.status),
    ...completionRows.map((item) => item.status),
  ];
  const blockingStatuses = Array.from(new Set(
    allStatuses.filter((status) => status !== 'passed' && status !== 'evidence_backed_defer'),
  ));
  const overallStatus = worstStatus(
    blockingStatuses as Array<Exclude<SurfaceGateStatus, 'evidence_backed_defer'>>,
    'passed',
  );

  return {
    version: 1,
    generatedAt: input.generatedAt,
    truthSource: input.truthSource,
    invocation: [...input.invocation],
    ...(input.campaign ? { campaign: input.campaign } : {}),
    currentSourceFingerprint: input.currentSourceFingerprint,
    git: input.git,
    proofInventory,
    t0,
    t1,
    completion,
    overall: {
      status: overallStatus,
      exitCode: overallStatus === 'passed' ? 0 : 1,
      hasEvidenceBackedDefers: allStatuses.includes('evidence_backed_defer'),
      blockingStatuses,
    },
  };
}

export function collectArtifactRequirements(): Partial<
Record<SurfaceGateProofId, ArtifactRequirement[]>
> {
  const output: Partial<Record<SurfaceGateProofId, ArtifactRequirement[]>> = {};
  const bindings = [
    ...SURFACE_T0_GATES.flatMap((gate) => gate.bindings),
    ...SURFACE_T1_GATES.flatMap((gate) => gate.bindings),
    ...SURFACE_COMPLETION_ROWS.flatMap((row) => row.bindings || []),
  ];
  for (const binding of bindings) {
    const requirements = output[binding.proof] || [];
    for (const requirement of binding.artifacts || []) {
      if (!requirements.some((item) => artifactRequirementKey(item) === artifactRequirementKey(requirement))) {
        requirements.push(requirement);
      }
    }
    output[binding.proof] = requirements;
  }
  return output;
}

export function artifactRecords(document: unknown, requirement: ArtifactRequirement): unknown[] {
  return valuesAtPath(document, requirement.recordPath);
}
