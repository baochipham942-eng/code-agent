import { describe, expect, it } from 'vitest';
import { ImagePayloadExceededError } from '../../../src/host/model/types';
import { parseImagePayloadError } from '../../../src/host/model/providers/shared';

describe('parseImagePayloadError', () => {
  it('classifies an Anthropic HTTP 413 request_too_large response', () => {
    const response = JSON.stringify({
      type: 'error',
      error: {
        type: 'provider_rejection',
        message: 'Request body rejected by provider',
      },
    });

    const error = parseImagePayloadError(response, 'claude', 413);

    expect(error).toBeInstanceOf(ImagePayloadExceededError);
    expect(error).toMatchObject({
      code: 'IMAGE_PAYLOAD_EXCEEDED',
      reason: 'payload_too_large',
      provider: 'claude',
      httpStatus: 413,
    });
    expect(error?.message).toMatch(/^The model request is too large/);
  });

  it('classifies request_too_large even when a gateway omits HTTP 413', () => {
    const response = JSON.stringify({
      type: 'error',
      error: {
        type: 'request_too_large',
        message: 'Request exceeds maximum allowed size of 32 MB',
      },
    });

    expect(parseImagePayloadError(response, 'claude')).toMatchObject({
      code: 'IMAGE_PAYLOAD_EXCEEDED',
      reason: 'payload_too_large',
      provider: 'claude',
      httpStatus: 413,
    });
  });

  it('classifies a provider response that exceeds the image count limit', () => {
    const response = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Too many images in request: 101 > 100',
      },
    });

    const error = parseImagePayloadError(response, 'claude', 400);

    expect(error).toBeInstanceOf(ImagePayloadExceededError);
    expect(error).toMatchObject({
      code: 'IMAGE_PAYLOAD_EXCEEDED',
      reason: 'too_many_images',
      provider: 'claude',
      httpStatus: 400,
    });
    expect(error?.message).toMatch(/^The model request contains too many images/);
  });

  it('does not steal token context overflow errors', () => {
    expect(parseImagePayloadError(
      'maximum context length is 200000 tokens; you requested 210000',
      'openai',
      400,
    )).toBeNull();
  });
});
