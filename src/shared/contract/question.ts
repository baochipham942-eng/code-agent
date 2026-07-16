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
      answers?: never;
    };
