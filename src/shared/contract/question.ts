// ============================================================================
// User Question Types (for Gen 3+ ask_user_question)
// ============================================================================

export interface UserQuestionOption {
  label: string;
  description: string;
}

export interface UserQuestion {
  question: string;
  header: string;
  options: UserQuestionOption[];
  multiSelect?: boolean;
}

export interface UserQuestionRequest {
  id: string;
  sessionId?: string;
  questions: UserQuestion[];
  timestamp: number;
}

export type UserQuestionResponse =
  | {
      requestId: string;
      answers: Record<string, string | string[]>; // question header -> selected option(s)
      declined?: false;
    }
  | {
      requestId: string;
      declined: true;
      /** 用户取消回答时可选填写的原因，透传给模型 */
      reason?: string;
      answers?: never;
    };
