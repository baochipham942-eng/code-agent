import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../..');
const CHAT_INPUT_PATH = path.join(ROOT, 'src/renderer/components/features/chat/ChatInput/index.tsx');

function getApplyRecommendationHandlerSource(): string {
  const source = readFileSync(CHAT_INPUT_PATH, 'utf8');
  const start = source.indexOf('const handleApplyModelStrategyRecommendation');
  const end = source.indexOf('return (', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('ChatInput model strategy recommendation wiring', () => {
  it('applies recommendations against the session-effective model, not the global default model', () => {
    const handlerSource = getApplyRecommendationHandlerSource();

    expect(handlerSource).toContain('recommendation: visibleModelStrategyRecommendation');
    expect(handlerSource).toMatch(/currentProvider:\s*effectiveProviderId/);
    expect(handlerSource).toMatch(/currentModel:\s*effectiveModelId/);
    expect(handlerSource).not.toMatch(/currentProvider:\s*modelConfig\.provider/);
    expect(handlerSource).not.toMatch(/currentModel:\s*modelConfig\.model/);
  });

  it('passes the session engine updater into recommendation side effects', () => {
    const handlerSource = getApplyRecommendationHandlerSource();

    expect(handlerSource).toContain('updateSessionEngine,');
    expect(handlerSource).toMatch(/\[.*updateSessionEngine.*visibleModelStrategyRecommendation.*\]/s);
  });

  it('records model strategy feedback for apply and dismiss actions', () => {
    const source = readFileSync(CHAT_INPUT_PATH, 'utf8');
    const handlerSource = getApplyRecommendationHandlerSource();

    expect(handlerSource).toContain('recordFeedback: recordModelStrategyFeedback');
    expect(source).toContain('POSTHOG_EVENTS.MODEL_STRATEGY_RECOMMENDATION_FEEDBACK');
    expect(source).toContain("buildModelStrategyRecommendationFeedback(visibleModelStrategyRecommendation, 'dismissed')");
    expect(source).toContain('onDismiss={handleDismissModelStrategyRecommendation}');
  });
});
