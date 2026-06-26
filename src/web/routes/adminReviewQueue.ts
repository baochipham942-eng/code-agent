import { Router } from 'express';
import type { Request, Response } from 'express';
import type {
  AdminReviewDecision,
  ArtifactIssue,
} from '../../shared/contract/productClosure';
import { getArtifactIssueRepository } from '../../host/services/core/repositories/ArtifactIssueRepository';
import { formatError } from '../helpers/utils';
import type { WebRouteLogger } from './routeTypes';

interface AdminReviewQueueRouterDeps {
  logger: WebRouteLogger;
}

function getRepoOrRespond(res: Response) {
  const repo = getArtifactIssueRepository();
  if (!repo) {
    res.status(503).json({
      success: false,
      error: { code: 'ARTIFACT_ISSUE_REPOSITORY_UNAVAILABLE', message: 'Artifact issue repository is not ready.' },
    });
  }
  return repo;
}

function readLimit(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isArtifactIssue(value: unknown): value is ArtifactIssue {
  if (!isRecord(value)) return false;
  const traceIdentity = value.traceIdentity;
  return (
    typeof value.issueId === 'string'
    && typeof value.artifactId === 'string'
    && typeof value.artifactKind === 'string'
    && isRecord(traceIdentity)
    && typeof traceIdentity.traceId === 'string'
    && typeof traceIdentity.traceSource === 'string'
    && typeof traceIdentity.sessionId === 'string'
    && typeof traceIdentity.replayKey === 'string'
    && typeof value.source === 'string'
    && typeof value.code === 'string'
    && typeof value.severity === 'string'
    && typeof value.status === 'string'
    && typeof value.title === 'string'
    && typeof value.message === 'string'
    && typeof value.createdAt === 'number'
    && typeof value.updatedAt === 'number'
    && Array.isArray(value.evidenceRefs)
  );
}

function readDecisionBody(body: unknown): {
  decision: AdminReviewDecision;
  reviewer: string;
  note?: string;
  repairInstruction?: string;
} | null {
  if (!isRecord(body)) return null;
  const decision = body.decision;
  const reviewer = body.reviewer;
  if (decision !== 'allow_release' && decision !== 'request_changes') return null;
  if (typeof reviewer !== 'string' || reviewer.trim().length === 0) return null;
  return {
    decision,
    reviewer: reviewer.trim(),
    note: typeof body.note === 'string' && body.note.trim().length > 0 ? body.note.trim() : undefined,
    repairInstruction: typeof body.repairInstruction === 'string' && body.repairInstruction.trim().length > 0
      ? body.repairInstruction.trim()
      : undefined,
  };
}

export function createAdminReviewQueueRouter(deps: AdminReviewQueueRouterDeps): Router {
  const router = Router();
  const { logger } = deps;

  router.get('/admin/review-queue', (req: Request, res: Response) => {
    const repo = getRepoOrRespond(res);
    if (!repo) return;

    try {
      const includeReviewed = req.query.includeReviewed === 'true';
      const limit = readLimit(req.query.limit);
      res.json({
        success: true,
        data: repo.listAdminReviewQueue({ includeReviewed, limit }),
      });
    } catch (error) {
      logger.error('Failed to list admin review queue:', error);
      res.status(500).json({
        success: false,
        error: { code: 'ADMIN_REVIEW_QUEUE_LIST_FAILED', message: formatError(error) },
      });
    }
  });

  router.post('/admin/review-queue/issues', (req: Request, res: Response) => {
    const repo = getRepoOrRespond(res);
    if (!repo) return;
    if (!isArtifactIssue(req.body)) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_ARTIFACT_ISSUE', message: 'Request body must be an ArtifactIssue.' },
      });
      return;
    }

    try {
      repo.upsertIssue(req.body);
      res.json({ success: true, data: repo.getIssue(req.body.issueId) });
    } catch (error) {
      logger.error('Failed to upsert artifact issue for admin review:', error);
      res.status(500).json({
        success: false,
        error: { code: 'ADMIN_REVIEW_ISSUE_UPSERT_FAILED', message: formatError(error) },
      });
    }
  });

  router.post('/admin/review-queue/:issueId/decision', (req: Request, res: Response) => {
    const repo = getRepoOrRespond(res);
    if (!repo) return;
    const issueIdParam = req.params.issueId;
    const issueId = Array.isArray(issueIdParam) ? issueIdParam[0] : issueIdParam;
    if (typeof issueId !== 'string' || issueId.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_ARTIFACT_ISSUE_ID', message: 'issueId is required.' },
      });
      return;
    }
    const decision = readDecisionBody(req.body);
    if (!decision) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_REVIEW_DECISION', message: 'decision and reviewer are required.' },
      });
      return;
    }

    try {
      const issue = repo.applyAdminReview(issueId, decision);
      if (!issue) {
        res.status(404).json({
          success: false,
          error: { code: 'ARTIFACT_ISSUE_NOT_FOUND', message: `Artifact issue ${issueId} was not found.` },
        });
        return;
      }

      const queueItem = repo
        .listAdminReviewQueue({ includeReviewed: true })
        .find((item) => item.issueId === issueId) ?? null;
      res.json({ success: true, data: { issue, queueItem } });
    } catch (error) {
      logger.error('Failed to apply admin review decision:', error);
      res.status(500).json({
        success: false,
        error: { code: 'ADMIN_REVIEW_DECISION_FAILED', message: formatError(error) },
      });
    }
  });

  return router;
}
