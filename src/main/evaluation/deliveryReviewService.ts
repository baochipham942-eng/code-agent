import type {
  DeliveryReviewRunResult,
  RunDeliveryReviewInput,
  ScenarioAcceptanceSkill,
} from '../../shared/contract/scenarioAcceptance';
import { buildDeliveryReviewMetadata } from '../../shared/contract/scenarioAcceptance';
import type { PreviewFeedbackItem } from '../../shared/contract/previewFeedback';
import { runScenarioAcceptance, listScenarioAcceptanceSkills } from '../agent/runtime/acceptance/AcceptanceRunner';
import { getPreviewFeedbackService } from './previewFeedbackService';
import { getReviewQueueService } from './reviewQueueService';

export class DeliveryReviewService {
  private static instance: DeliveryReviewService | null = null;

  static getInstance(): DeliveryReviewService {
    if (!this.instance) {
      this.instance = new DeliveryReviewService();
    }
    return this.instance;
  }

  listScenarioSkills(): ScenarioAcceptanceSkill[] {
    return listScenarioAcceptanceSkills();
  }

  run(input: RunDeliveryReviewInput): DeliveryReviewRunResult {
    const result = runScenarioAcceptance(input);
    const previewFeedbackService = getPreviewFeedbackService();
    const previewFeedbackItems = input.createPreviewFeedback === false
      ? []
      : reconcilePreviewFeedback(input, result, previewFeedbackService);

    const shouldEnqueue = input.enqueueOnNeedsWork !== false && result.status !== 'pass';
    const reviewQueueItem = shouldEnqueue
      ? getReviewQueueService().enqueueSession({
        sessionId: input.sessionId,
        sessionTitle: input.sessionTitle,
        reason: 'delivery_review',
        enqueueSource: 'current_session_bar',
        deliveryReview: buildDeliveryReviewMetadata(result),
      })
      : undefined;

    return {
      ...result,
      reviewQueueItem,
      previewFeedbackItems,
    };
  }
}

function reconcilePreviewFeedback(
  input: RunDeliveryReviewInput,
  result: ReturnType<typeof runScenarioAcceptance>,
  previewFeedbackService: ReturnType<typeof getPreviewFeedbackService>,
): PreviewFeedbackItem[] {
  const existing = previewFeedbackService.list({ sessionId: input.sessionId });
  const artifactIds = new Set(input.artifacts.map((artifact) => artifact.id));
  const currentKeys = new Set(result.issues.map((issue) => `${issue.artifactId}:${issue.code}`));
  const feedbackItems: PreviewFeedbackItem[] = [];

  for (const issue of result.issues) {
    const existingOpen = existing.find((item) => (
      item.source === 'delivery_review'
      && item.previewItemId === issue.artifactId
      && item.issueCode === issue.code
      && item.status !== 'resolved'
      && item.status !== 'dismissed'
    ));
    feedbackItems.push(existingOpen ?? previewFeedbackService.createFromIssue(input.sessionId, result.id, issue));
  }

  for (const item of existing) {
    if (
      item.source === 'delivery_review'
      && artifactIds.has(item.previewItemId)
      && (item.status === 'open' || item.status === 'sent')
      && !currentKeys.has(`${item.previewItemId}:${item.issueCode}`)
    ) {
      const resolved = previewFeedbackService.updateStatus({
        id: item.id,
        status: 'resolved',
      });
      if (resolved) feedbackItems.push(resolved);
    }
  }

  return feedbackItems;
}

let deliveryReviewServiceInstance: DeliveryReviewService | null = null;

export function getDeliveryReviewService(): DeliveryReviewService {
  if (!deliveryReviewServiceInstance) {
    deliveryReviewServiceInstance = DeliveryReviewService.getInstance();
  }
  return deliveryReviewServiceInstance;
}
