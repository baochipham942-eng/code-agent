export interface RuntimeControlPort {
  setPlanMode(active: boolean): void;
  isPlanMode(): boolean;
  generateAutoContinuationPrompt(): string;
}
