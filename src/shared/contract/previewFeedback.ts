import type { ScenarioAcceptanceAnchor } from './scenarioAcceptance';

export type PreviewFeedbackStatus = 'open' | 'sent' | 'resolved' | 'dismissed';

export type PreviewFeedbackSource = 'user' | 'delivery_review';

export interface PreviewFeedbackItem {
  id: string;
  sessionId: string;
  previewItemId: string;
  status: PreviewFeedbackStatus;
  source: PreviewFeedbackSource;
  note: string;
  anchor: ScenarioAcceptanceAnchor;
  reviewId?: string;
  reviewCheckId?: string;
  issueCode?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ListPreviewFeedbackInput {
  sessionId: string;
  previewItemId?: string;
  status?: PreviewFeedbackStatus;
}

export interface CreatePreviewFeedbackInput {
  id?: string;
  sessionId: string;
  previewItemId: string;
  source?: PreviewFeedbackSource;
  note: string;
  anchor?: ScenarioAcceptanceAnchor;
  reviewId?: string;
  reviewCheckId?: string;
  issueCode?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface UpdatePreviewFeedbackStatusInput {
  id: string;
  status: PreviewFeedbackStatus;
  updatedAt?: number;
}

export interface SendPreviewFeedbackToChatInput {
  sessionId: string;
  previewItemId?: string;
  includeResolved?: boolean;
}

export interface PreviewFeedbackChatContext {
  message: string;
  items: PreviewFeedbackItem[];
}

export function isPreviewFeedbackStatus(value: unknown): value is PreviewFeedbackStatus {
  return value === 'open'
    || value === 'sent'
    || value === 'resolved'
    || value === 'dismissed';
}
