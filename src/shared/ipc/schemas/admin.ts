import { z } from 'zod';
import type {
  AdminControlPlaneAuditEventItem,
  AdminControlPlaneAuditEventListResult,
  AdminControlPlaneRolloutSummaryItem,
  AdminControlPlaneRolloutSummaryResult,
  AdminCreateInviteCodeInput,
  AdminInviteCodeItem,
  AdminInviteCodeListResult,
  AdminUpdateInviteCodeInput,
  AdminUserDashboardItem,
  AdminUserDashboardResult,
} from '../../contract/admin';
import { IPC_DOMAINS, type IPCResponse } from '../domains';
import { IPCResponseSchema, channelSchema } from './core';

const OptionalStringSchema = z.string().optional();
const NullableStringSchema = z.string().nullable().optional();

const AdminUserDashboardItemSchema: z.ZodType<AdminUserDashboardItem> = z.object({
  id: z.string(),
  email: z.string(),
  username: OptionalStringSchema,
  nickname: OptionalStringSchema,
  avatarUrl: OptionalStringSchema,
  isAdmin: z.boolean(),
  status: z.enum(['active', 'suspended', 'deleted']),
  signupSource: OptionalStringSchema,
  inviteCode: OptionalStringSchema,
  provider: OptionalStringSchema,
  createdAt: z.string(),
  lastSignInAt: OptionalStringSchema,
  lastActiveAt: OptionalStringSchema,
  lastSyncAt: OptionalStringSchema,
  lastSessionUpdatedAt: z.number().optional(),
  deviceCount: z.number(),
  sessionCount: z.number(),
  messageCount: z.number(),
});

const AdminUserDashboardResultSchema: z.ZodType<AdminUserDashboardResult> = z.object({
  users: z.array(AdminUserDashboardItemSchema),
  unavailableReason: OptionalStringSchema,
});

const AdminInviteCodeItemSchema: z.ZodType<AdminInviteCodeItem> = z.object({
  id: z.string(),
  code: z.string(),
  label: OptionalStringSchema,
  maxUses: z.number(),
  useCount: z.number(),
  remainingUses: z.number(),
  expiresAt: OptionalStringSchema,
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: OptionalStringSchema,
  lastUsedAt: OptionalStringSchema,
  createdBy: OptionalStringSchema,
  createdByEmail: OptionalStringSchema,
});

const AdminInviteCodeListResultSchema: z.ZodType<AdminInviteCodeListResult> = z.object({
  inviteCodes: z.array(AdminInviteCodeItemSchema),
  unavailableReason: OptionalStringSchema,
});

const AdminCreateInviteCodeInputSchema: z.ZodType<AdminCreateInviteCodeInput> = z.object({
  code: OptionalStringSchema,
  label: OptionalStringSchema,
  maxUses: z.number(),
  expiresAt: NullableStringSchema,
});

const AdminUpdateInviteCodeInputSchema: z.ZodType<AdminUpdateInviteCodeInput> = z.object({
  id: z.string(),
  label: NullableStringSchema,
  maxUses: z.number().optional(),
  expiresAt: NullableStringSchema,
  isActive: z.boolean().optional(),
});

const AdminControlPlaneArtifactKindSchema = z.enum([
  'cloud_config',
  'capability_registry',
  'prompt_registry',
  'update_manifest',
]);

const AdminControlPlaneReleaseChannelSchema = z.enum(['stable', 'beta', 'canary']);

const AdminControlPlaneAuditEventItemSchema: z.ZodType<AdminControlPlaneAuditEventItem> = z.object({
  id: z.string(),
  createdAt: z.string(),
  artifactKind: AdminControlPlaneArtifactKindSchema,
  payloadVersion: OptionalStringSchema,
  releaseChannel: AdminControlPlaneReleaseChannelSchema.optional(),
  keyId: OptionalStringSchema,
  contentHash: OptionalStringSchema,
  outcome: z.enum(['served', 'not_modified', 'head', 'error']),
  statusCode: z.number(),
  errorCode: OptionalStringSchema,
  subjectId: OptionalStringSchema,
  subjectSource: OptionalStringSchema,
  entitlementStatus: OptionalStringSchema,
  entitlementPlan: OptionalStringSchema,
  entitlementReason: OptionalStringSchema,
});

const AdminControlPlaneAuditEventListResultSchema: z.ZodType<AdminControlPlaneAuditEventListResult> =
  z.object({
    events: z.array(AdminControlPlaneAuditEventItemSchema),
    unavailableReason: OptionalStringSchema,
  });

const AdminControlPlaneRolloutSummaryItemSchema: z.ZodType<AdminControlPlaneRolloutSummaryItem> =
  z.object({
    artifactKind: AdminControlPlaneArtifactKindSchema,
    payloadVersion: OptionalStringSchema,
    releaseChannel: AdminControlPlaneReleaseChannelSchema.optional(),
    keyId: OptionalStringSchema,
    contentHash: OptionalStringSchema,
    lastSeenAt: OptionalStringSchema,
    servedCount: z.number(),
    errorCount: z.number(),
  });

const AdminControlPlaneRolloutSummaryResultSchema: z.ZodType<AdminControlPlaneRolloutSummaryResult> =
  z.object({
    items: z.array(AdminControlPlaneRolloutSummaryItemSchema),
    unavailableReason: OptionalStringSchema,
  });

const ListUsersRequestSchema = z.object({
  action: z.literal('listUsers'),
  payload: z.undefined().optional(),
  requestId: z.string().optional(),
});

const ListInviteCodesRequestSchema = z.object({
  action: z.literal('listInviteCodes'),
  payload: z.undefined().optional(),
  requestId: z.string().optional(),
});

const CreateInviteCodeRequestSchema = z.object({
  action: z.literal('createInviteCode'),
  payload: AdminCreateInviteCodeInputSchema,
  requestId: z.string().optional(),
});

const UpdateInviteCodeRequestSchema = z.object({
  action: z.literal('updateInviteCode'),
  payload: AdminUpdateInviteCodeInputSchema,
  requestId: z.string().optional(),
});

const ListControlPlaneAuditEventsRequestSchema = z.object({
  action: z.literal('listControlPlaneAuditEvents'),
  payload: z.object({ limit: z.number().optional() }).optional(),
  requestId: z.string().optional(),
});

const ListControlPlaneRolloutSummaryRequestSchema = z.object({
  action: z.literal('listControlPlaneRolloutSummary'),
  payload: z.undefined().optional(),
  requestId: z.string().optional(),
});

const AdminRequestSchema = z.discriminatedUnion('action', [
  ListUsersRequestSchema,
  ListInviteCodesRequestSchema,
  CreateInviteCodeRequestSchema,
  UpdateInviteCodeRequestSchema,
  ListControlPlaneAuditEventsRequestSchema,
  ListControlPlaneRolloutSummaryRequestSchema,
]);

const AdminResultDataSchema = z.union([
  AdminUserDashboardResultSchema,
  AdminInviteCodeListResultSchema,
  AdminControlPlaneAuditEventListResultSchema,
  AdminControlPlaneRolloutSummaryResultSchema,
]);

const AdminResponseSchema: z.ZodType<IPCResponse<z.infer<typeof AdminResultDataSchema>>> =
  IPCResponseSchema(AdminResultDataSchema);

export const AdminSchemas = {
  REQUEST: channelSchema({
    channel: IPC_DOMAINS.ADMIN,
    payload: AdminRequestSchema,
    response: AdminResponseSchema,
  }),
  LIST_USERS: channelSchema({
    channel: IPC_DOMAINS.ADMIN,
    payload: ListUsersRequestSchema,
    response: IPCResponseSchema(AdminUserDashboardResultSchema),
  }),
  LIST_INVITE_CODES: channelSchema({
    channel: IPC_DOMAINS.ADMIN,
    payload: ListInviteCodesRequestSchema,
    response: IPCResponseSchema(AdminInviteCodeListResultSchema),
  }),
  CREATE_INVITE_CODE: channelSchema({
    channel: IPC_DOMAINS.ADMIN,
    payload: CreateInviteCodeRequestSchema,
    response: IPCResponseSchema(AdminInviteCodeListResultSchema),
  }),
  UPDATE_INVITE_CODE: channelSchema({
    channel: IPC_DOMAINS.ADMIN,
    payload: UpdateInviteCodeRequestSchema,
    response: IPCResponseSchema(AdminInviteCodeListResultSchema),
  }),
  LIST_CONTROL_PLANE_AUDIT_EVENTS: channelSchema({
    channel: IPC_DOMAINS.ADMIN,
    payload: ListControlPlaneAuditEventsRequestSchema,
    response: IPCResponseSchema(AdminControlPlaneAuditEventListResultSchema),
  }),
  LIST_CONTROL_PLANE_ROLLOUT_SUMMARY: channelSchema({
    channel: IPC_DOMAINS.ADMIN,
    payload: ListControlPlaneRolloutSummaryRequestSchema,
    response: IPCResponseSchema(AdminControlPlaneRolloutSummaryResultSchema),
  }),
} as const;

export type AdminRequest = z.infer<typeof AdminRequestSchema>;
