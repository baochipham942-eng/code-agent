// ============================================================================
// FindingsManager - Manages research findings and notes
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Finding, FindingCategory, PlanningConfig } from './types';

// ----------------------------------------------------------------------------
// Category Labels
// ----------------------------------------------------------------------------

const CATEGORY_LABELS: Record<FindingCategory, string> = {
  code: 'Code Insights',
  architecture: 'Architecture',
  dependency: 'Dependencies',
  issue: 'Issues Found',
  insight: 'General Insights',
};

// ----------------------------------------------------------------------------
// FindingsManager
// ----------------------------------------------------------------------------

export class FindingsManager {
  private findingsPath: string;
  private findings: Finding[] = [];
  private loaded: boolean = false;

  constructor(private config: PlanningConfig) {
    this.findingsPath = path.join(
      config.workingDirectory,
      '.code-agent',
      'plans',
      config.sessionId,
      'findings.md'
    );
  }

  // ==========================================================================
  // Public Methods
  // ==========================================================================

  /**
   * Add a new finding
   */
  async add(
    finding: Omit<Finding, 'id' | 'timestamp'>
  ): Promise<Finding> {
    await this.ensureLoaded();

    const newFinding: Finding = {
      ...finding,
      id: this.generateId(),
      timestamp: Date.now(),
    };

    this.findings.push(newFinding);
    await this.saveToFile();

    return newFinding;
  }

  /**
   * Get all findings
   */
  async getAll(): Promise<Finding[]> {
    await this.ensureLoaded();
    return [...this.findings];
  }

  /**
   * Get findings by category
   */
  async getByCategory(category: FindingCategory): Promise<Finding[]> {
    await this.ensureLoaded();
    return this.findings.filter((f) => f.category === category);
  }

  /**
   * Search findings by keyword
   */
  async search(keyword: string): Promise<Finding[]> {
    await this.ensureLoaded();
    const lowerKeyword = keyword.toLowerCase();
    return this.findings.filter(
      (f) =>
        f.title.toLowerCase().includes(lowerKeyword) ||
        f.content.toLowerCase().includes(lowerKeyword)
    );
  }

  /**
   * Get a summary of findings for context injection
   */
  async getSummary(maxPerCategory: number = 3): Promise<string> {
    await this.ensureLoaded();

    if (this.findings.length === 0) {
      return '';
    }

    const grouped = this.groupByCategory();
    let summary = '<findings-summary>\n';
    summary += `Total findings: ${this.findings.length}\n\n`;

    for (const [category, items] of Object.entries(grouped)) {
      const label = CATEGORY_LABELS[category as FindingCategory] || category;
      summary += `**${label}:**\n`;

      const recent = items
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, maxPerCategory);

      for (const item of recent) {
        summary += `- ${item.title}\n`;
      }
      summary += '\n';
    }

    summary += '</findings-summary>';
    return summary;
  }

  /**
   * Delete a finding by ID
   */
  async delete(id: string): Promise<boolean> {
    await this.ensureLoaded();

    const index = this.findings.findIndex((f) => f.id === id);
    if (index === -1) return false;

    this.findings.splice(index, 1);
    await this.saveToFile();
    return true;
  }

  /**
   * Clear all findings
   */
  async clear(): Promise<void> {
    this.findings = [];
    await this.saveToFile();
  }

  /**
   * Get count of findings
   */
  async getCount(): Promise<number> {
    await this.ensureLoaded();
    return this.findings.length;
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
    let md = `# Findings & Notes\n\n`;
    md += `> Research findings and important discoveries.\n`;
    md += `> Use this file to persist knowledge that shouldn't be lost.\n\n`;
    md += `---\n\n`;

    const grouped = this.groupByCategory();

    if (Object.keys(grouped).length === 0) {
      md += `*No findings recorded yet.*\n`;
    } else {
      for (const [category, items] of Object.entries(grouped)) {
        const label = CATEGORY_LABELS[category as FindingCategory] || category;
        md += `## ${label}\n\n`;

        const sortedItems = items.sort((a, b) => b.timestamp - a.timestamp);

        for (const item of sortedItems) {
          const date = new Date(item.timestamp).toISOString().split('T')[0];
          md += `### ${item.title}\n\n`;
          md += `*${date}*\n\n`;
          md += `${item.content}\n\n`;

          if (item.source) {
            md += `> Source: \`${item.source}\`\n\n`;
          }
        }
      }
    }

    md += `\n---\n\n`;
    md += `<!-- Findings data for parsing -->\n`;
    md += `<!-- FINDINGS_JSON: ${JSON.stringify(this.findings)} -->\n`;

    await fs.mkdir(path.dirname(this.findingsPath), { recursive: true });
    await fs.writeFile(this.findingsPath, md, 'utf-8');
  }

  private async loadFromFile(): Promise<void> {
    try {
      const content = await fs.readFile(this.findingsPath, 'utf-8');

      // Try to parse from JSON comment
      const jsonMatch = content.match(/<!-- FINDINGS_JSON: (.+) -->/);
      if (jsonMatch) {
        try {
          this.findings = JSON.parse(jsonMatch[1]) as Finding[];
          return;
        } catch {
          // Fall through to empty
        }
      }

      this.findings = [];
    } catch {
      // File doesn't exist, start fresh
      this.findings = [];
    }
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private groupByCategory(): Record<string, Finding[]> {
    const grouped: Record<string, Finding[]> = {};

    for (const finding of this.findings) {
      if (!grouped[finding.category]) {
        grouped[finding.category] = [];
      }
      grouped[finding.category].push(finding);
    }

    return grouped;
  }

  private generateId(): string {
    return `find-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
