import { afterEach, describe, expect, it } from 'vitest';
import {
  canOfferRegisteredUserQuestion,
  cancelRegisteredUserQuestion,
  offerRegisteredUserQuestion,
  registerUserQuestionRoute,
} from '../../../../src/host/services/capabilities/hostCapabilityPorts';
import type { UserQuestionRequest } from '../../../../src/shared/contract';

const request: UserQuestionRequest = {
  id: 'q-route',
  sessionId: 'session-route',
  timestamp: 1,
  questions: [{ question: 'Q', header: 'H', options: [{ label: 'A', description: 'a' }] }],
};

describe('user question routes fan out instead of occupying a single slot', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it('two routes can register together; offer reaches both; one missing still leaves the other', () => {
    const offered: string[] = [];
    const cancelled: string[] = [];
    cleanups.push(registerUserQuestionRoute({
      canOffer: () => true,
      offer: (next) => { offered.push(`voice:${next.id}`); return true; },
      cancel: id => cancelled.push(`voice:${id}`),
    }));
    cleanups.push(registerUserQuestionRoute({
      canOffer: () => true,
      offer: (next) => { offered.push(`companion:${next.id}`); return true; },
      cancel: id => cancelled.push(`companion:${id}`),
    }));
    expect(canOfferRegisteredUserQuestion('session-route')).toBe(true);
    expect(offerRegisteredUserQuestion(request, () => {})).toBe(true);
    expect(offered).toEqual(['voice:q-route', 'companion:q-route']);
    cancelRegisteredUserQuestion('q-route');
    expect(cancelled).toEqual(['voice:q-route', 'companion:q-route']);
  });

  it('a voice route that cannot offer does not block a companion route that can', () => {
    cleanups.push(registerUserQuestionRoute({
      canOffer: () => false,
      offer: () => false,
      cancel: () => {},
    }));
    cleanups.push(registerUserQuestionRoute({
      canOffer: id => id === 'session-route',
      offer: () => true,
      cancel: () => {},
    }));
    expect(canOfferRegisteredUserQuestion('session-route')).toBe(true);
    expect(canOfferRegisteredUserQuestion('other')).toBe(false);
    expect(offerRegisteredUserQuestion(request, () => {})).toBe(true);
  });
});
