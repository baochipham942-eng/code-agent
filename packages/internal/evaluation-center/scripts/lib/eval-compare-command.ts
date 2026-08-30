export async function dispatchEvalCompareCommand(input: {
  jsonEvents: boolean;
  run(): Promise<void>;
  reportError(message: string): void;
}): Promise<never> {
  try {
    await input.run();
  } catch (error) {
    input.reportError(error instanceof Error ? error.message : String(error));
    if (input.jsonEvents) throw error;
    process.exit(1);
  }
  process.exit(0);
}
