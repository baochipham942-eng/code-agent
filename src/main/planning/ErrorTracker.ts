// ============================================================================
// ErrorTracker - Tracks errors to avoid repeating mistakes (3-Strike Rule)
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type { ErrorRecord, PlanningConfig } from './types';

// ----------------------------------------------------------------------------
// ErrorTracker
// ----------------------------------------------------------------------------

export class ErrorTracker {
  private errorsPath: string;
  private errors: Map<string, ErrorRecord> = new Map();
  private loaded: boolean = false;

  constructor(private config: PlanningConfig) {
    this.errorsPath = path.join(
      config.workingDirectory,
      '.code-agent',
      'plans',
      config.sessionId,
      'errors.md'
    );
  }

  // ==========================================================================
  // Public Methods
  // ==========================================================================

  /**
   * Log an error
   */
  async log(error: {
    toolName: string;
    message: string;
    params?: Record<string, unknown>;
    stack?: string;
  }): Promise<void> {
    await this.ensureLoaded();

    const key = this.getErrorKey(error.toolName, error.message);
    const existing = this.errors.get(key);

    if (existing) {
      existing.count++;
      existing.timestamp = Date.now();
      existing.params = error.params;
    } else {
      this.errors.set(key, {
        id: this.generateId(),
        toolName: error.toolName,
        message: error.message,
        params: error.params,
        stack: error.stack,
        timestamp: Date.now(),
        count: 1,
      });
    }

    await this.saveToFile();
  }

  /**
   * Get recent errors for a specific tool
   */
  async getRecentErrors(
    toolName?: string,
    limit: number = 5
  ): Promise<ErrorRecord[]> {
    await this.ensureLoaded();

    let errors = Array.from(this.errors.values());

    if (toolName) {
      errors = errors.filter((e) => e.toolName === toolName);
    }

    return errors
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Get error count for 3-Strike Rule
   */
  async getErrorCount(toolName: string, message: string): Promise<number> {
    await this.ensureLoaded();

    const key = this.getErrorKey(toolName, message);
    const record = this.errors.get(key);
    return record?.count || 0;
  }

  /**
   * Check if error has reached strike limit
   */
  async hasReachedStrikeLimit(
    toolName: string,
    message: string,
    limit: number = 3
  ): Promise<boolean> {
    const count = await this.getErrorCount(toolName, message);
    return count >= limit;
  }

  /**
   * Get all errors
   */
  async getAll(): Promise<ErrorRecord[]> {
    await this.ensureLoaded();
    return Array.from(this.errors.values());
  }

  /**
   * Clear all errors
   */
  async clear(): Promise<void> {
    this.errors.clear();
    await this.saveToFile();
  }

  /**
   * Clear errors for a specific tool
   */
  async clearForTool(toolName: string): Promise<void> {
    await this.ensureLoaded();

    for (const [key, error] of this.errors) {
      if (error.toolName === toolName) {
        this.errors.delete(key);
      }
    }

    await this.saveToFile();
  }

  // ==========================================================================
  // File Operations
  // ==========================================================================

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.loadFromFile();
      this.loaded = true;
    }
  }

  private async saveToFile(): Promise<void> {
    let md = `# Error Log\n\n`;
    md += `> This file tracks errors to avoid repeating the same mistakes.\n`;
    md += `> Errors that occur 3+ times trigger the 3-Strike Rule warning.\n\n`;
    md += `---\n\n`;

    const sortedErrors = Array.from(this.errors.values()).sort(
      (a, b) => b.timestamp - a.timestamp
    );

    if (sortedErrors.length === 0) {
      md += `*No errors recorded.*\n`;
    } else {
      for (const error of sortedErrors) {
        const date = new Date(error.timestamp).toISOString();
        const strikeWarning = error.count >= 3 ? ' **[3-STRIKE]**' : '';

        md += `## ${error.toolName}${strikeWarning}\n\n`;
        md += `- **Count:** ${error.count} times\n`;
        md += `- **Last occurred:** ${date}\n`;
        md += `- **Message:** ${error.message}\n`;

        if (error.params) {
          md += `- **Params:**\n`;
          md += `  \`\`\`json\n`;
          md += `  ${JSON.stringify(error.params, null, 2).split('\n').join('\n  ')}\n`;
          md += `  \`\`\`\n`;
        }

        md += `\n---\n\n`;
      }
    }

    md += `\n<!-- Error data for parsing -->\n`;
    md += `<!-- ERRORS_JSON: ${JSON.stringify(Array.from(this.errors.entries()))} -->\n`;

    await fs.mkdir(path.dirname(this.errorsPath), { recursive: true });
    await fs.writeFile(this.errorsPath, md, 'utf-8');
  }

  private async loadFromFile(): Promise<void> {
    try {
      const content = await fs.readFile(this.errorsPath, 'utf-8');

      // Try to parse from JSON comment
      const jsonMatch = content.match(/<!-- ERRORS_JSON: (.+) -->/);
      if (jsonMatch) {
        try {
          const entries = JSON.parse(jsonMatch[1]) as [string, ErrorRecord][];
          this.errors = new Map(entries);
          return;
        } catch {
          // Fall through to manual parsing
        }
      }

      // Manual parsing fallback (basic)
      this.errors = new Map();
    } catch {
      // File doesn't exist, start fresh
      this.errors = new Map();
    }
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Generate a unique key for error deduplication
   */
  private getErrorKey(toolName: string, message: string): string {
    // Normalize message by replacing numbers with N
    const normalizedMessage = message
      .replace(/\d+/g, 'N')
      .replace(/['"][^'"]*['"]/g, '"..."')
      .substring(0, 100);
    return `${toolName}:${normalizedMessage}`;
  }

  private generateId(): string {
    return `err-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
