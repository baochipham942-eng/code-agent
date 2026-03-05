// A/B Grader - Blind grading of two outputs using dual rubric
import type { TestCase, DualRubricScore } from '../types';

export interface GradeOutput {
  responses: string[];
  toolCalls: string[];
}

export interface GradeResult {
  scoreA: DualRubricScore;
  scoreB: DualRubricScore;
  winner: 'A' | 'B' | 'tie';
  reasoning: string;
}

/**
 * Blind grader that scores two outputs without knowing their identity.
 * Uses a dual rubric: Content (correctness/completeness/accuracy) and
 * Structure (organization/formatting/usability), each scored 1-5.
 */
export class ABGrader {
  /**
   * Grade with an LLM via callback. Builds the prompt, sends it through
   * the callback, and parses the JSON response.
   */
  async gradeWithLLM(
    testCase: TestCase,
    outputA: GradeOutput,
    outputB: GradeOutput,
    llmCall: (prompt: string) => Promise<string>,
  ): Promise<GradeResult> {
    const prompt = this.buildGradingPrompt(testCase, outputA, outputB);
    const raw = await llmCall(prompt);
    return this.parseGradeResponse(raw);
  }

  /**
   * Rule-based fallback grader. Uses simple heuristics when no LLM is available.
   */
  gradeByRules(
    _testCase: TestCase,
    outputA: GradeOutput,
    outputB: GradeOutput,
  ): GradeResult {
    const scoreA = this.heuristicScore(outputA);
    const scoreB = this.heuristicScore(outputB);

    let winner: 'A' | 'B' | 'tie';
    if (scoreA.combined > scoreB.combined) {
      winner = 'A';
    } else if (scoreB.combined > scoreA.combined) {
      winner = 'B';
    } else {
      winner = 'tie';
    }

    const reasoning =
      `Heuristic comparison: A combined=${scoreA.combined.toFixed(2)}, ` +
      `B combined=${scoreB.combined.toFixed(2)}. ` +
      `A had ${outputA.responses.length} responses and ${outputA.toolCalls.length} tool calls. ` +
      `B had ${outputB.responses.length} responses and ${outputB.toolCalls.length} tool calls.`;

    return { scoreA, scoreB, winner, reasoning };
  }

  /**
   * Main entry: grade two outputs. Uses LLM if callback provided, otherwise rules.
   */
  async grade(
    testCase: TestCase,
    outputA: GradeOutput,
    outputB: GradeOutput,
    llmCall?: (prompt: string) => Promise<string>,
  ): Promise<GradeResult> {
    if (llmCall) {
      return this.gradeWithLLM(testCase, outputA, outputB, llmCall);
    }
    return this.gradeByRules(testCase, outputA, outputB);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildGradingPrompt(
    testCase: TestCase,
    outputA: GradeOutput,
    outputB: GradeOutput,
  ): string {
    return `You are an impartial evaluator comparing two AI agent outputs for the same task.

## Task
${testCase.description}

## Prompt Given to Both Agents
${testCase.prompt}

## Output A
### Responses
${outputA.responses.map((r, i) => `[${i + 1}] ${r}`).join('\n\n')}

### Tool Calls
${outputA.toolCalls.length > 0 ? outputA.toolCalls.join('\n') : '(none)'}

## Output B
### Responses
${outputB.responses.map((r, i) => `[${i + 1}] ${r}`).join('\n\n')}

### Tool Calls
${outputB.toolCalls.length > 0 ? outputB.toolCalls.join('\n') : '(none)'}

## Scoring Rubric

Score each output on two dimensions (1-5 scale each):

**Content** (correctness, completeness, accuracy):
- 5: Perfect — fully correct, complete, accurate
- 4: Good — mostly correct with minor gaps
- 3: Adequate — partially correct, some gaps
- 2: Poor — significant errors or omissions
- 1: Incorrect — fundamentally wrong

**Structure** (organization, formatting, usability):
- 5: Excellent — well-organized, clear formatting, easy to use
- 4: Good — mostly well-structured
- 3: Adequate — some organizational issues
- 2: Poor — disorganized, hard to follow
- 1: Bad — no structure, unusable

## Response Format
Respond with ONLY valid JSON (no markdown fences):
{
  "scoreA": {
    "content": { "correctness": <1-5>, "completeness": <1-5>, "accuracy": <1-5> },
    "structure": { "organization": <1-5>, "formatting": <1-5>, "usability": <1-5> }
  },
  "scoreB": {
    "content": { "correctness": <1-5>, "completeness": <1-5>, "accuracy": <1-5> },
    "structure": { "organization": <1-5>, "formatting": <1-5>, "usability": <1-5> }
  },
  "winner": "A" | "B" | "tie",
  "reasoning": "<brief explanation>"
}`;
  }

  private parseGradeResponse(raw: string): GradeResult {
    // Strip markdown code fences if present
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned) as {
      scoreA: {
        content: { correctness: number; completeness: number; accuracy: number };
        structure: { organization: number; formatting: number; usability: number };
      };
      scoreB: {
        content: { correctness: number; completeness: number; accuracy: number };
        structure: { organization: number; formatting: number; usability: number };
      };
      winner: 'A' | 'B' | 'tie';
      reasoning: string;
    };

    const scoreA = this.buildDualRubricScore(parsed.scoreA);
    const scoreB = this.buildDualRubricScore(parsed.scoreB);

    return {
      scoreA,
      scoreB,
      winner: parsed.winner,
      reasoning: parsed.reasoning,
    };
  }

  private buildDualRubricScore(raw: {
    content: { correctness: number; completeness: number; accuracy: number };
    structure: { organization: number; formatting: number; usability: number };
  }): DualRubricScore {
    const contentTotal =
      (raw.content.correctness + raw.content.completeness + raw.content.accuracy) / 3;
    const structureTotal =
      (raw.structure.organization + raw.structure.formatting + raw.structure.usability) / 3;
    const combined = (contentTotal + structureTotal) / 2;

    return {
      content: { ...raw.content, total: contentTotal },
      structure: { ...raw.structure, total: structureTotal },
      combined,
    };
  }

  private heuristicScore(output: GradeOutput): DualRubricScore {
    const totalResponseLength = output.responses.reduce((sum, r) => sum + r.length, 0);
    const toolCount = output.toolCalls.length;
    const responseCount = output.responses.length;

    // Heuristic: longer, more detailed responses with tool usage score higher
    // Content heuristics (1-5 scale)
    const lengthScore = Math.min(5, Math.max(1, Math.round(totalResponseLength / 200)));
    const toolScore = Math.min(5, Math.max(1, 1 + toolCount));
    const responseScore = Math.min(5, Math.max(1, responseCount + 1));

    const correctness = Math.round((lengthScore + toolScore) / 2);
    const completeness = Math.round((lengthScore + responseScore) / 2);
    const accuracy = lengthScore; // rough proxy

    // Structure heuristics
    const hasMultipleResponses = responseCount > 1;
    const hasToolCalls = toolCount > 0;
    const organization = hasMultipleResponses ? 4 : 3;
    const formatting = lengthScore >= 3 ? 4 : 3;
    const usability = hasToolCalls ? 4 : 3;

    const contentTotal = (correctness + completeness + accuracy) / 3;
    const structureTotal = (organization + formatting + usability) / 3;
    const combined = (contentTotal + structureTotal) / 2;

    return {
      content: { correctness, completeness, accuracy, total: contentTotal },
      structure: { organization, formatting, usability, total: structureTotal },
      combined,
    };
  }
}
