import { randomUUID } from 'node:crypto';
import type { ComputerUseExpectationV1 } from '../../../shared/contract/desktop';
import type {
  SurfaceActionResultV1,
  SurfaceExecutionEventV1,
  SurfaceExpectationV1,
  SurfaceSessionViewV1,
} from '../../../shared/contract/surfaceExecution';
import type { SurfaceGrantSubjectV1 } from './SurfaceAccessGrantService';
import {
  type SurfaceRuntimeIdentityV1,
  type SurfaceExecutionRuntime,
  type SurfaceComputerActionDispatchV1,
} from './SurfaceExecutionRuntime';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';
import type {
  SurfaceBrowserActionDispatchV1,
} from './surfaceBrowserRuntimeTypes';
import {
  SurfaceOrganizationPolicyService,
  type SurfaceOrganizationTargetContextV1,
} from './SurfaceOrganizationPolicyService';
import {
  SurfaceProviderRegistry,
  SurfaceProviderRegistryError,
  type SurfaceProviderRegistrationV1,
} from './SurfaceProviderRegistry';

export const EXTERNAL_SURFACE_AGENT_ENTRYPOINTS_V1 = [
  'neo surface',
  'neo browser',
] as const;

export type ExternalSurfaceAgentEntrypointV1 =
  typeof EXTERNAL_SURFACE_AGENT_ENTRYPOINTS_V1[number];

export interface ExternalSurfaceAgentRequestV1 {
  version: 1;
  entrypoint: ExternalSurfaceAgentEntrypointV1;
  operation: string;
  arguments?: Record<string, unknown>;
  expectation?: SurfaceExpectationV1 | ComputerUseExpectationV1;
  deadlineMs?: number;
}

export interface ExternalSurfaceProviderDispatchRequestV1 {
  version: 1;
  entrypoint: ExternalSurfaceAgentEntrypointV1;
  operation: string;
  /** Host-validated action arguments. Session, provider, target, and grant authority stay out of band. */
  arguments: Record<string, unknown>;
}

interface ExternalSurfaceHostAuthorityBaseV1 {
  /** Host-owned identity. Never deserialize this value from the external request. */
  identity: SurfaceRuntimeIdentityV1;
  /** Provider selection is Host-owned so an external caller cannot opt into Relay login state. */
  providerId: string;
  organizationId: string;
  policyTarget: SurfaceOrganizationTargetContextV1;
  approvalRef?: string;
  surfaceSessionId: string;
}

export interface ExternalBrowserHostAuthorityV1 extends ExternalSurfaceHostAuthorityBaseV1 {
  surface: 'browser';
  predecessorStateId: string;
  leaseId?: string;
  dispatch(
    signal: AbortSignal,
    subject: SurfaceGrantSubjectV1,
    request: ExternalSurfaceProviderDispatchRequestV1,
  ): Promise<SurfaceBrowserActionDispatchV1<unknown>>;
}

export interface ExternalComputerHostAuthorityV1 extends ExternalSurfaceHostAuthorityBaseV1 {
  surface: 'computer';
  providerStateId: string;
  dispatch(
    signal: AbortSignal,
    subject: SurfaceGrantSubjectV1,
    request: ExternalSurfaceProviderDispatchRequestV1,
  ): Promise<SurfaceComputerActionDispatchV1<unknown>>;
}

export type ExternalSurfaceHostAuthorityV1 =
  | ExternalBrowserHostAuthorityV1
  | ExternalComputerHostAuthorityV1;

export interface ExternalSurfaceAgentResultV1 {
  version: 1;
  entrypoint: ExternalSurfaceAgentEntrypointV1;
  surface: 'browser' | 'computer';
  provider: string;
  session: SurfaceSessionViewV1;
  action: SurfaceActionResultV1;
  events: SurfaceExecutionEventV1[];
  providerResult: unknown;
}

interface ExternalSurfaceAgentAdapterOptions {
  runtime: Pick<
    SurfaceExecutionRuntime,
    'capabilities' | 'executeBrowserAction' | 'executeComputerAction'
  >;
  providers?: SurfaceProviderRegistry;
  policy: SurfaceOrganizationPolicyService;
  createOperationId?: () => string;
}

const ALLOWED_REQUEST_KEYS = new Set([
  'version',
  'entrypoint',
  'operation',
  'arguments',
  'expectation',
  'deadlineMs',
]);

const FORBIDDEN_AUTHORITY_KEYS = new Set([
  'identity',
  'owner',
  'conversationid',
  'runid',
  'turnid',
  'agentid',
  'sessionid',
  'surfacesessionid',
  'provider',
  'providerid',
  'engine',
  'browserengine',
  'grantid',
  'grantref',
  'approvalid',
  'approvalref',
  'leaseid',
  'tabid',
  'tabref',
  'tabindex',
  'windowid',
  'windowref',
  'windowindex',
  'browserinstanceid',
  'deviceid',
  'pid',
  'target',
  'documentrevision',
  'windowrevision',
  'predecessorstateid',
  'providerstateid',
  'profileid',
  'profileref',
  'accountid',
  'accountref',
  'targetapp',
  'appid',
  'appname',
  'bundleid',
  '__proto__',
  'prototype',
  'constructor',
]);

class ExternalSurfaceBoundaryError extends Error {
  constructor(readonly reason: string) {
    super('External Surface request crossed a Host authority boundary.');
    this.name = 'ExternalSurfaceBoundaryError';
  }
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9_]/g, '').replace(/_/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertNoExternalAuthority(value: unknown): void {
  const visited = new WeakSet<object>();
  let visitedEntries = 0;
  const walk = (current: unknown, depth: number): void => {
    if (depth > 20 || visitedEntries > 2_000) {
      throw new ExternalSurfaceBoundaryError('payload_complexity_exceeded');
    }
    if (!current || typeof current !== 'object') return;
    if (visited.has(current)) throw new ExternalSurfaceBoundaryError('payload_cycle_forbidden');
    visited.add(current);
    if (Array.isArray(current)) {
      for (const item of current) {
        visitedEntries += 1;
        walk(item, depth + 1);
      }
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      visitedEntries += 1;
      if (FORBIDDEN_AUTHORITY_KEYS.has(normalizedKey(key))) {
        throw new ExternalSurfaceBoundaryError('external_authority_forbidden');
      }
      walk(child, depth + 1);
    }
  };
  walk(value, 0);
}

function requestDomain(
  argumentsValue: Record<string, unknown>,
  fallback: string | undefined,
): string | undefined {
  const url = argumentsValue.url;
  if (typeof url !== 'string' || !url.trim()) return fallback;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

function projectSession(session: Parameters<typeof structuredClone<SurfaceSessionViewV1>>[0]): SurfaceSessionViewV1 {
  const { grantId: _grantId, ...view } = session as typeof session & { grantId?: string };
  void _grantId;
  return structuredClone(view);
}

function providerContext(
  registration: SurfaceProviderRegistrationV1,
): Pick<SurfaceProviderRegistrationV1, 'providerId' | 'providerClass' | 'executionSurface'> {
  return {
    providerId: registration.providerId,
    providerClass: registration.providerClass,
    executionSurface: registration.executionSurface,
  };
}

export class ExternalSurfaceAgentAdapter {
  private readonly runtime: ExternalSurfaceAgentAdapterOptions['runtime'];
  private readonly providers: SurfaceProviderRegistry;
  private readonly policy: SurfaceOrganizationPolicyService;
  private readonly createOperationId: () => string;

  constructor(options: ExternalSurfaceAgentAdapterOptions) {
    this.runtime = options.runtime;
    this.providers = options.providers || new SurfaceProviderRegistry();
    this.policy = options.policy;
    this.createOperationId = options.createOperationId
      || (() => `external_surface_${randomUUID()}`);
  }

  async invoke(
    authority: ExternalSurfaceHostAuthorityV1,
    untrustedRequest: ExternalSurfaceAgentRequestV1,
  ): Promise<ExternalSurfaceAgentResultV1> {
    const operationId = this.createOperationId();
    try {
      this.assertHostAuthority(authority);
      assertNoExternalAuthority(untrustedRequest);
      this.assertRequest(untrustedRequest);
      if (untrustedRequest.entrypoint === 'neo browser' && authority.surface !== 'browser') {
        throw new ExternalSurfaceBoundaryError('entrypoint_surface_mismatch');
      }

      const operation = untrustedRequest.operation;
      const argumentsValue = structuredClone(untrustedRequest.arguments || {});
      if (authority.surface === 'browser' && argumentsValue.action === undefined) {
        argumentsValue.action = operation;
      }
      const capability = authority.surface === 'browser'
        ? this.runtime.capabilities.resolve('browser_action', operation, argumentsValue)
        : this.runtime.capabilities.resolve('computer_use', operation, argumentsValue);
      const payloadBytes = Buffer.byteLength(JSON.stringify(untrustedRequest), 'utf8');
      const provider = this.providers.resolveForExecution({
        providerId: authority.providerId,
        surface: authority.surface,
        operation,
        requiredCapabilities: capability.capabilities,
        payloadBytes,
      });
      const policyTarget: SurfaceOrganizationTargetContextV1 = authority.surface === 'browser'
        ? {
            ...authority.policyTarget,
            domain: requestDomain(argumentsValue, authority.policyTarget.domain),
          }
        : { ...authority.policyTarget };
      const decision = this.policy.evaluate({
        organizationId: authority.organizationId,
        provider: providerContext(provider),
        operation,
        capabilities: capability.capabilities,
        risk: capability.catalog.risk,
        target: policyTarget,
        ...(authority.approvalRef ? { approvalRef: authority.approvalRef } : {}),
      });
      if (decision.decision !== 'allow') {
        throw this.runtimeError(
          authority,
          operationId,
          decision.errorCode || 'SURFACE_POLICY_BLOCKED',
          decision.reason,
        );
      }

      const deadlineMs = this.deadline(untrustedRequest.deadlineMs);
      const providerRequest: ExternalSurfaceProviderDispatchRequestV1 = {
        version: 1,
        entrypoint: untrustedRequest.entrypoint,
        operation,
        arguments: structuredClone(argumentsValue),
      };
      if (authority.surface === 'browser') {
        const result = await this.runtime.executeBrowserAction({
          identity: authority.identity,
          provider: authority.providerId,
          surfaceSessionId: authority.surfaceSessionId,
          predecessorStateId: authority.predecessorStateId,
          ...(authority.leaseId ? { leaseId: authority.leaseId } : {}),
          operationId,
          action: operation,
          arguments: argumentsValue,
          ...(untrustedRequest.expectation
            ? { expectation: untrustedRequest.expectation as SurfaceExpectationV1 }
            : {}),
          deadlineMs,
          dispatch: async (signal, subject) => authority.dispatch(
            signal,
            subject,
            structuredClone(providerRequest),
          ),
        });
        return {
          version: 1,
          entrypoint: untrustedRequest.entrypoint,
          surface: 'browser',
          provider: authority.providerId,
          session: projectSession(result.session),
          action: result.surfaceResult,
          events: result.events,
          providerResult: result.providerResult,
        };
      }

      const result = await this.runtime.executeComputerAction({
        identity: authority.identity,
        provider: authority.providerId,
        providerStateId: authority.providerStateId,
        operationId,
        arguments: argumentsValue,
        ...(untrustedRequest.expectation
          ? { expectation: untrustedRequest.expectation as ComputerUseExpectationV1 }
          : {}),
        deadlineMs,
        dispatch: async (signal, subject) => authority.dispatch(
          signal,
          subject,
          structuredClone(providerRequest),
        ),
      });
      return {
        version: 1,
        entrypoint: untrustedRequest.entrypoint,
        surface: 'computer',
        provider: authority.providerId,
        session: projectSession(result.session),
        action: result.surfaceResult,
        events: result.events,
        providerResult: result.providerResult,
      };
    } catch (error) {
      if (error instanceof SurfaceExecutionRuntimeError) throw error;
      if (error instanceof SurfaceProviderRegistryError) {
        throw this.runtimeError(
          authority,
          operationId,
          'SURFACE_CAPABILITY_UNSUPPORTED',
          error.reason,
        );
      }
      if (error instanceof ExternalSurfaceBoundaryError) {
        throw this.runtimeError(
          authority,
          operationId,
          'SURFACE_POLICY_BLOCKED',
          error.reason,
        );
      }
      if (error instanceof Error && 'code' in error
        && error.code === 'SURFACE_CAPABILITY_UNSUPPORTED') {
        throw this.runtimeError(
          authority,
          operationId,
          'SURFACE_CAPABILITY_UNSUPPORTED',
          'operation_unsupported',
        );
      }
      throw error;
    }
  }

  private assertHostAuthority(authority: ExternalSurfaceHostAuthorityV1): void {
    if (!authority.identity?.conversationId?.trim()
      || !authority.identity.runId?.trim()
      || !authority.identity.agentId?.trim()
      || !authority.providerId.trim()
      || !authority.surfaceSessionId.trim()
      || !authority.organizationId.trim()) {
      throw new ExternalSurfaceBoundaryError('host_authority_incomplete');
    }
    if (authority.surface === 'browser' && !authority.predecessorStateId.trim()) {
      throw new ExternalSurfaceBoundaryError('host_observation_binding_missing');
    }
    if (authority.surface === 'computer' && !authority.providerStateId.trim()) {
      throw new ExternalSurfaceBoundaryError('host_observation_binding_missing');
    }
  }

  private assertRequest(request: ExternalSurfaceAgentRequestV1): void {
    if (!isRecord(request)
      || request.version !== 1
      || !EXTERNAL_SURFACE_AGENT_ENTRYPOINTS_V1.includes(request.entrypoint)
      || !/^[a-z][a-z0-9_:-]{0,127}$/.test(request.operation)
      || (request.arguments !== undefined && !isRecord(request.arguments))
      || Object.keys(request).some((key) => !ALLOWED_REQUEST_KEYS.has(key))) {
      throw new ExternalSurfaceBoundaryError('external_request_invalid');
    }
  }

  private deadline(value: number | undefined): number {
    if (value === undefined) return 60_000;
    if (!Number.isFinite(value) || value <= 0 || value > 120_000) {
      throw new ExternalSurfaceBoundaryError('deadline_invalid');
    }
    return Math.floor(value);
  }

  private runtimeError(
    authority: ExternalSurfaceHostAuthorityV1,
    operationId: string,
    code:
      | 'SURFACE_CAPABILITY_UNSUPPORTED'
      | 'SURFACE_POLICY_BLOCKED'
      | 'SURFACE_APPROVAL_REQUIRED'
      | 'SURFACE_APPROVAL_INVALID',
    reason: string,
  ): SurfaceExecutionRuntimeError {
    const approval = code === 'SURFACE_APPROVAL_REQUIRED' || code === 'SURFACE_APPROVAL_INVALID';
    return new SurfaceExecutionRuntimeError({
      code,
      message: approval
        ? 'External Surface operation requires a valid Host approval.'
        : 'External Surface operation was rejected by the Host boundary.',
      phase: 'prepare',
      retryable: code !== 'SURFACE_POLICY_BLOCKED',
      userActionRequired: approval,
      recommendedAction: approval
        ? 'Request a new organization-scoped Host approval.'
        : 'Use a registered provider and a Host-issued Surface binding.',
      surface: authority.surface,
      provider: authority.providerId || 'unknown',
      sessionId: authority.surfaceSessionId || 'external-unprepared',
      operationId,
      detailsSafe: {
        reason,
        boundary: 'external-surface-agent-v1',
      },
    });
  }
}
