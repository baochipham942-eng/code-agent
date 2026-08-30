import type { UserQuestionRequest, UserQuestionResponse } from '../../../shared/contract';

export type HostCapabilityCleanup = () => void | Promise<void>;
export type TurnOutcomeResolver = (
  sessionId: string,
  dispatchedAtMs: number,
) => Promise<'done' | 'unverified'>;

export interface UserQuestionRoute {
  canOffer: (sessionId: string | undefined) => boolean;
  offer: (
    request: UserQuestionRequest,
    respond: (response: UserQuestionResponse) => void,
  ) => boolean;
  cancel: (requestId: string) => void;
}

let turnOutcomeResolver: TurnOutcomeResolver | null = null;
let userQuestionRoute: UserQuestionRoute | null = null;

function exclusiveRegistration<T>(
  current: T | null,
  next: T,
  label: string,
  clear: () => void,
): HostCapabilityCleanup {
  if (current && current !== next) throw new Error(`${label} already has a registered provider`);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    clear();
  };
}

export function registerTurnOutcomeResolver(resolver: TurnOutcomeResolver): HostCapabilityCleanup {
  const cleanup = exclusiveRegistration(
    turnOutcomeResolver,
    resolver,
    'turn outcome resolver',
    () => {
      if (turnOutcomeResolver === resolver) turnOutcomeResolver = null;
    },
  );
  turnOutcomeResolver = resolver;
  return cleanup;
}

export async function resolveRegisteredTurnOutcome(
  sessionId: string,
  dispatchedAtMs: number,
): Promise<'done' | 'unverified'> {
  return turnOutcomeResolver
    ? turnOutcomeResolver(sessionId, dispatchedAtMs)
    : 'unverified';
}

export function registerUserQuestionRoute(route: UserQuestionRoute): HostCapabilityCleanup {
  const cleanup = exclusiveRegistration(
    userQuestionRoute,
    route,
    'user question route',
    () => {
      if (userQuestionRoute === route) userQuestionRoute = null;
    },
  );
  userQuestionRoute = route;
  return cleanup;
}

export function canOfferRegisteredUserQuestion(sessionId: string | undefined): boolean {
  return userQuestionRoute?.canOffer(sessionId) ?? false;
}

export function offerRegisteredUserQuestion(
  request: UserQuestionRequest,
  respond: (response: UserQuestionResponse) => void,
): boolean {
  return userQuestionRoute?.offer(request, respond) ?? false;
}

export function cancelRegisteredUserQuestion(requestId: string): void {
  userQuestionRoute?.cancel(requestId);
}
