export interface ImageGenerateRequest {
  index: number;
  prompt: string;
}

export interface ImageGenerateRequestResult<T> {
  index: number;
  status: 'saved' | 'failed';
  value?: T;
  error?: string;
  artifact?: unknown;
}

/**
 * Run image requests with bounded parallelism. A failed request is isolated from
 * its siblings; an abort stops new work and records every unscheduled request.
 */
export async function runImageGenerateBatch<T>(input: {
  requests: readonly ImageGenerateRequest[];
  signal: AbortSignal;
  concurrency?: number;
  run: (request: ImageGenerateRequest) => Promise<T>;
}): Promise<Array<ImageGenerateRequestResult<T>>> {
  const results: Array<ImageGenerateRequestResult<T> | undefined> = Array.from(
    { length: input.requests.length },
    () => undefined,
  );
  const concurrency = Math.max(1, Math.min(input.concurrency ?? 3, input.requests.length || 1));
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      if (input.signal.aborted) return;
      const requestIndex = nextIndex;
      nextIndex += 1;
      const request = input.requests[requestIndex];
      if (!request) return;

      try {
        const value = await input.run(request);
        results[requestIndex] = { index: request.index, status: 'saved', value };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        results[requestIndex] = {
          index: request.index,
          status: 'failed',
          error: input.signal.aborted || message === 'aborted' ? 'aborted' : message,
          artifact: error && typeof error === 'object' && 'artifact' in error
            ? (error as { artifact?: unknown }).artifact
            : undefined,
        };
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  for (let index = 0; index < input.requests.length; index += 1) {
    if (!results[index]) {
      results[index] = {
        index: input.requests[index].index,
        status: 'failed',
        error: 'aborted',
      };
    }
  }

  return results as Array<ImageGenerateRequestResult<T>>;
}
