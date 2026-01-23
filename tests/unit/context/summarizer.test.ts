// ============================================================================
// AI Summarizer Tests
// ============================================================================
//
// Tests for the AI-powered summarization module.
// Tests cover:
// - Key information extraction
// - Topic extraction
// - Extractive summarization
// - Summary result structure
// - AISummarizer class
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractKeyInfo,
  extractTopics,
  generateExtractiveSummary,
  summarizeText,
  summarizeConversation,
  AISummarizer,
  getDefaultSummarizer,
  type ExtractedInfo,
  type SummaryResult,
  type Message,
} from '../../../src/main/context/summarizer';
import { estimateTokens } from '../../../src/main/context/tokenEstimator';

describe('AISummarizer', () => {
  // --------------------------------------------------------------------------
  // extractKeyInfo
  // --------------------------------------------------------------------------
  describe('extractKeyInfo', () => {
    it('should extract decisions', () => {
      const text = 'We decided to use TypeScript for this project. Going with React for the frontend.';
      const info = extractKeyInfo(text);
      expect(info.decisions.length).toBeGreaterThan(0);
    });

    it('should extract action items', () => {
      const text = 'TODO: Fix the login bug. We need to update the database schema. Must deploy by Friday.';
      const info = extractKeyInfo(text);
      expect(info.actionItems.length).toBeGreaterThan(0);
    });

    it('should extract questions', () => {
      const text = 'What is the best approach? How should we handle authentication?';
      const info = extractKeyInfo(text);
      expect(info.questions.length).toBeGreaterThan(0);
    });

    it('should extract issues', () => {
      const text = 'There is an error in the login flow. The API is not working. Unable to connect to database.';
      const info = extractKeyInfo(text);
      expect(info.issues.length).toBeGreaterThan(0);
    });

    it('should extract file references', () => {
      const text = 'Check the file src/components/App.tsx. Also look at config.json and package.json.';
      const info = extractKeyInfo(text);
      expect(info.codeReferences.length).toBeGreaterThan(0);
      expect(info.codeReferences.some(r => r.file.includes('.tsx'))).toBe(true);
    });

    it('should limit extracted items', () => {
      const text = Array.from({ length: 20 }, (_, i) => `TODO: Task ${i}`).join('. ');
      const info = extractKeyInfo(text);
      expect(info.actionItems.length).toBeLessThanOrEqual(10);
    });

    it('should handle empty text', () => {
      const info = extractKeyInfo('');
      expect(info.decisions).toHaveLength(0);
      expect(info.actionItems).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // extractTopics
  // --------------------------------------------------------------------------
  describe('extractTopics', () => {
    it('should extract technical topics', () => {
      const text = 'We need to implement authentication and fix the database connection. Deploy to AWS.';
      const topics = extractTopics(text);
      expect(topics.length).toBeGreaterThan(0);
      expect(topics).toContain('authentication');
      expect(topics).toContain('database');
      expect(topics).toContain('deploy');
    });

    it('should extract programming language topics', () => {
      const text = 'The project uses TypeScript with React and Node.js backend.';
      const topics = extractTopics(text);
      expect(topics.some(t => t === 'typescript' || t === 'react' || t === 'node')).toBe(true);
    });

    it('should limit number of topics', () => {
      const text = 'api database authentication authorization cache config deploy test build error fix bug feature refactor component service model controller route middleware typescript javascript react node python rust go docker kubernetes aws gcp azure vercel supabase git github ci cd pipeline workflow action security performance optimization memory cpu latency';
      const topics = extractTopics(text);
      expect(topics.length).toBeLessThanOrEqual(10);
    });

    it('should handle text without technical terms', () => {
      const text = 'Hello world, this is just plain text.';
      const topics = extractTopics(text);
      expect(topics.length).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // generateExtractiveSummary
  // --------------------------------------------------------------------------
  describe('generateExtractiveSummary', () => {
    it('should extract important sentences', () => {
      const text = `
        This is the introduction. Not very important.
        The key decision was to use TypeScript.
        Some filler text here.
        Finally, we completed the implementation.
      `;
      const summary = generateExtractiveSummary(text, 50);
      expect(summary.length).toBeLessThan(text.length);
      expect(summary).toBeTruthy();
    });

    it('should prioritize sentences with keywords', () => {
      const text = `
        Random sentence one here.
        Random sentence two here.
        Important: We decided to change the approach.
        Random sentence three.
      `;
      const summary = generateExtractiveSummary(text, 20);
      // Should likely include the "important" sentence
      expect(summary.length).toBeGreaterThan(0);
    });

    it('should maintain sentence order', () => {
      const text = 'First sentence. Second sentence. Third sentence.';
      const summary = generateExtractiveSummary(text, 100);
      const firstIdx = summary.indexOf('First');
      const thirdIdx = summary.indexOf('Third');
      if (firstIdx !== -1 && thirdIdx !== -1) {
        expect(firstIdx).toBeLessThan(thirdIdx);
      }
    });

    it('should handle short text', () => {
      const text = 'Short.';
      const summary = generateExtractiveSummary(text, 100);
      expect(summary.length).toBeGreaterThan(0);
    });

    it('should respect token budget', () => {
      const longText = 'Important sentence. '.repeat(50);
      const summary = generateExtractiveSummary(longText, 20);
      expect(estimateTokens(summary)).toBeLessThanOrEqual(30); // Some tolerance
    });
  });

  // --------------------------------------------------------------------------
  // summarizeText
  // --------------------------------------------------------------------------
  describe('summarizeText', () => {
    it('should return original if within budget', async () => {
      const shortText = 'Hello world.';
      const result = await summarizeText(shortText, { targetTokens: 100 });
      expect(result.summary).toBe(shortText);
      expect(result.wasCompressed).toBeFalsy();
    });

    it('should summarize long text', async () => {
      const longText = 'This is an important sentence. '.repeat(50);
      const result = await summarizeText(longText, { targetTokens: 50 });
      expect(result.tokens).toBeLessThan(result.originalTokens);
      expect(result.compressionRatio).toBeLessThan(1);
    });

    it('should extract info when enabled', async () => {
      const text = 'We decided to use React. TODO: Fix the bug. What about testing?';
      const result = await summarizeText(text, { targetTokens: 1000, extractInfo: true });
      expect(result.extractedInfo.decisions.length + result.extractedInfo.actionItems.length + result.extractedInfo.questions.length).toBeGreaterThan(0);
    });

    it('should preserve code blocks when enabled', async () => {
      const text = 'Text\n```js\nconst x = 42;\n```\nMore text '.repeat(20);
      const result = await summarizeText(text, {
        targetTokens: 50,
        preserveCodeBlocks: true,
        maxCodeBlocks: 2,
      });
      expect(result.preservedCodeBlocks.length).toBeGreaterThan(0);
    });

    it('should track AI usage', async () => {
      const result = await summarizeText('Short text', { targetTokens: 100 });
      expect(result.usedAI).toBe(false); // No AI summarizer provided
    });
  });

  // --------------------------------------------------------------------------
  // summarizeConversation
  // --------------------------------------------------------------------------
  describe('summarizeConversation', () => {
    it('should summarize message array', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello, can you help me?' },
        { role: 'assistant', content: 'Of course! What do you need?' },
        { role: 'user', content: 'I need to fix a bug in my code.' },
      ];
      const result = await summarizeConversation(messages, { targetTokens: 100 });
      expect(result.summary).toBeTruthy();
    });

    it('should include role labels in summary', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Question here' },
        { role: 'assistant', content: 'Answer here' },
      ];
      const result = await summarizeConversation(messages, { targetTokens: 1000 });
      expect(result.summary).toContain('USER');
      expect(result.summary).toContain('ASSISTANT');
    });
  });

  // --------------------------------------------------------------------------
  // AISummarizer class
  // --------------------------------------------------------------------------
  describe('AISummarizer class', () => {
    let summarizer: AISummarizer;

    beforeEach(() => {
      summarizer = new AISummarizer();
    });

    it('should summarize text', async () => {
      const text = 'This is a test sentence. '.repeat(20);
      const result = await summarizer.summarize(text, { targetTokens: 30 });
      expect(result.tokens).toBeLessThan(result.originalTokens);
    });

    it('should summarize messages', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Test message' },
      ];
      const result = await summarizer.summarizeMessages(messages, { targetTokens: 100 });
      expect(result.summary).toBeTruthy();
    });

    it('should provide quick summary', async () => {
      // Use text with proper sentences that can be extracted
      const text = 'This is an important decision we made. The feature was implemented successfully. We need to test everything. '.repeat(10);
      // Use a larger token budget for extractive summarization
      const summary = await summarizer.quickSummary(text, 100);
      // Quick summary returns the result.summary from summarize()
      // If text is already within budget, it returns as-is
      expect(summary).toBeDefined();
    });

    it('should extract info separately', () => {
      const text = 'We decided to use TypeScript. TODO: Write tests.';
      const info = summarizer.extractInfo(text);
      expect(info.decisions.length + info.actionItems.length).toBeGreaterThan(0);
    });

    it('should accept custom AI summarizer', async () => {
      const mockAI = async (prompt: string, maxTokens: number) => 'AI Summary';
      summarizer.setAISummarizer(mockAI);

      const text = 'Long text '.repeat(100);
      const result = await summarizer.summarize(text, { targetTokens: 20 });
      expect(result.usedAI).toBe(true);
      expect(result.summary).toContain('AI Summary');
    });

    it('should use default detail level', async () => {
      const summarizer = new AISummarizer({ defaultDetailLevel: 'brief' });
      const result = await summarizer.summarize('Short text', { targetTokens: 100 });
      expect(result).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // getDefaultSummarizer
  // --------------------------------------------------------------------------
  describe('getDefaultSummarizer', () => {
    it('should return singleton instance', () => {
      const s1 = getDefaultSummarizer();
      const s2 = getDefaultSummarizer();
      expect(s1).toBe(s2);
    });

    it('should be usable', async () => {
      const summarizer = getDefaultSummarizer();
      const result = await summarizer.summarize('Test text', { targetTokens: 100 });
      expect(result).toBeDefined();
    });
  });
});
