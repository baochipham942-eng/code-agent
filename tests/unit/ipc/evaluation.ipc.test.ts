import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/platform', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
  },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock('../../../src/main/platform/windowBridge', () => ({
  broadcastToRenderer: vi.fn(),
}));

vi.mock('../../../src/main/evaluation/EvaluationService', () => ({
  EvaluationService: {
    getInstance: () => ({
      evaluateSession: vi.fn(),
      getResult: vi.fn(),
      listHistory: vi.fn(),
      exportReport: vi.fn(),
      deleteResult: vi.fn(),
    }),
  },
}));

vi.mock('../../../src/main/evaluation/sessionAnalyticsService', () => ({
  getSessionAnalyticsService: () => ({}),
}));

vi.mock('../../../src/main/evaluation/swissCheeseEvaluator', () => ({
  getSwissCheeseEvaluator: () => ({}),
}));

vi.mock('../../../src/main/evaluation/annotationProxy', () => ({
  AnnotationProxy: {
    getInstance: () => ({
      saveAnnotation: vi.fn(),
      getAxialCoding: vi.fn(),
      getAllAnnotations: vi.fn(),
    }),
  },
}));

vi.mock('../../../src/main/evaluation/reviewQueueService', () => ({
  getReviewQueueService: () => ({}),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { mergeExperimentSummaryJson } from '../../../src/main/ipc/evaluation.ipc';

describe('evaluation.ipc experiment summary merge', () => {
  it('preserves canonical adapter fields when updating run status', () => {
    const merged = mergeExperimentSummaryJson(JSON.stringify({
      total: 2,
      passed: 1,
      source: 'test-runner',
      aggregation: 'best_score_pass_at_k',
      canonical: {
        schemaVersion: 1,
        averageScore100: 70,
        caseCount: 2,
      },
    }), {
      status: 'completed',
      duration: 1234,
      avgScore: 0.7,
    });

    expect(JSON.parse(merged)).toEqual({
      total: 2,
      passed: 1,
      source: 'test-runner',
      aggregation: 'best_score_pass_at_k',
      canonical: {
        schemaVersion: 1,
        averageScore100: 70,
        caseCount: 2,
      },
      status: 'completed',
      duration: 1234,
      avgScore: 0.7,
    });
  });
});
