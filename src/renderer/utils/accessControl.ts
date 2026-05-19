// ============================================================================
// Renderer Access Control
// Small UI-facing registry for admin-only surfaces.
// ============================================================================

export interface AccessSubject {
  isAdmin?: boolean | null;
}

export const ACCESS_CONTROL_REGISTRY = {
  'settings.users': {
    label: '用户看板',
    adminOnly: true,
  },
  'settings.invites': {
    label: '邀请码',
    adminOnly: true,
  },
  'settings.controlPlane': {
    label: 'Control Plane',
    adminOnly: true,
  },
  'settings.capabilities': {
    label: '能力治理',
    adminOnly: true,
  },
  'settings.plugins': {
    label: '插件管理',
    adminOnly: true,
  },
  'settings.hooks': {
    label: 'Hook 原始配置',
    adminOnly: true,
  },
  'prompt.manager': {
    label: '提示词',
    adminOnly: true,
  },
  'eval.center': {
    label: '评测中心',
    adminOnly: true,
  },
  'eval.telemetry': {
    label: 'Telemetry',
    adminOnly: true,
  },
  'eval.replay': {
    label: 'Replay',
    adminOnly: true,
  },
  'eval.reviewQueue': {
    label: 'Review Queue',
    adminOnly: true,
  },
} as const;

export type AccessControlledFeature = keyof typeof ACCESS_CONTROL_REGISTRY;

export function createAccessSubject(subject?: AccessSubject | null): AccessSubject {
  return {
    isAdmin: subject?.isAdmin === true,
  };
}

export function canAccessFeature(
  feature: AccessControlledFeature,
  subject?: AccessSubject | null,
): boolean {
  const rule = ACCESS_CONTROL_REGISTRY[feature];
  if (!rule.adminOnly) return true;
  return subject?.isAdmin === true;
}

export function canAccessAnyFeature(
  features: readonly AccessControlledFeature[],
  subject?: AccessSubject | null,
): boolean {
  return features.some((feature) => canAccessFeature(feature, subject));
}
