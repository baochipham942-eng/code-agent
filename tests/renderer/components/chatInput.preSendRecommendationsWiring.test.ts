import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../..');
const CHAT_INPUT_PATH = path.join(ROOT, 'src/renderer/components/features/chat/ChatInput/index.tsx');

describe('ChatInput pre-send recommendation wiring', () => {
  it('does not run text-heuristic capability or model recommendations while composing', () => {
    const source = readFileSync(CHAT_INPUT_PATH, 'utf8');

    expect(source).not.toContain('CapabilitySuggestionStrip');
    expect(source).not.toContain('buildCapabilitySemanticSuggestions');
    expect(source).not.toContain('ModelStrategyRecommendationStrip');
    expect(source).not.toContain('buildModelStrategyRecommendation({');
    expect(source).toContain("useSkillRecommendations(currentSessionId, '')");
    expect(source).not.toContain('useSkillRecommendations(currentSessionId, value)');
  });
});
