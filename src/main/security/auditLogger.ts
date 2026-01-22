// ============================================================================
// Audit Logger - JSONL-based audit logging system
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { createLogger } from '../services/infra/logger';
import { maskSensitiveData } from './sensitiveDetector';

const logger = createLogger('AuditLogger');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Event types for audit logging
 */
export type AuditEventType =
  | 'tool_usage'
  | 'permission_check'
  | 'file_access'
  | 'command_execution'
  | 'security_incident'
  | 'session_start'
  | 'session_end'
  | 'authentication'
  | 'network_request';

/**
 * Audit log entry structure
 */
export interface AuditEntry {
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** ISO 8601 formatted timestamp */
  timestampISO: string;
  /** Type of event being logged */
  eventType: AuditEventType;
  /** Session ID for correlation */
  sessionId: string;
  /** Tool or component name */
  toolName: string;
  /** Input parameters (sanitized) */
  input: Record<string, unknown>;
  /** Output or result (truncated if large) */
  output?: string;
  /** Execution duration in milliseconds */
  duration: number;
  /** Whether the operation succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Security flags triggered */
  securityFlags?: string[];
  /** Risk level if applicable */
  riskLevel?: 'safe' | 'low' | 'medium' | 'high' | 'critical';
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Query options for retrieving audit logs
 */
export interface AuditQueryOptions {
  /** Start timestamp (inclusive) */
  startTime?: number;
  /** End timestamp (inclusive) */
  endTime?: number;
  /** Filter by session ID */
  sessionId?: string;
  /** Filter by event type */
  eventType?: AuditEventType;
  /** Filter by tool name */
  toolName?: string;
  /** Only return failed operations */
  failedOnly?: boolean;
  /** Only return security incidents */
  securityOnly?: boolean;
  /** Maximum number of entries to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

/**
 * Query result
 */
export interface AuditQueryResult {
  entries: AuditEntry[];
  total: number;
  hasMore: boolean;
}

// ----------------------------------------------------------------------------
// Audit Logger Class
// ----------------------------------------------------------------------------

/**
 * Audit Logger - Records all tool executions to JSONL files
 *
 * Features:
 * - Daily log rotation (YYYY-MM-DD.jsonl)
 * - Automatic sensitive data masking
 * - Time-range queries
 * - Session-based filtering
 * - Output truncation for large results
 */
export class AuditLogger {
  private auditDir: string;
  private currentDate: string;
  private writeStream: fs.WriteStream | null = null;
  private maxOutputLength = 10000;
  private enabled = true;

  constructor(auditDir?: string) {
    this.auditDir = auditDir || this.getDefaultAuditDir();
    this.currentDate = this.getDateString();
    this.ensureAuditDir();
  }

  /**
   * Get the default audit directory
   */
  private getDefaultAuditDir(): string {
    try {
      const userDataPath = app.getPath('userData');
      return path.join(userDataPath, 'audit');
    } catch {
      // Fallback for non-Electron environments (e.g., testing)
      return path.join(process.env.HOME || '/tmp', '.code-agent', 'audit');
    }
  }

  /**
   * Ensure audit directory exists
   */
  private ensureAuditDir(): void {
    try {
      if (!fs.existsSync(this.auditDir)) {
        fs.mkdirSync(this.auditDir, { recursive: true });
        logger.info('Created audit directory', { path: this.auditDir });
      }
    } catch (error) {
      logger.error('Failed to create audit directory', error as Error);
      this.enabled = false;
    }
  }

  /**
   * Get current date string for file naming
   */
  private getDateString(date: Date = new Date()): string {
    return date.toISOString().split('T')[0];
  }

  /**
   * Get the log file path for a given date
   */
  private getLogFilePath(dateString: string): string {
    return path.join(this.auditDir, `${dateString}.jsonl`);
  }

  /**
   * Get or create write stream for current date
   */
  private getWriteStream(): fs.WriteStream | null {
    if (!this.enabled) {
      return null;
    }

    const today = this.getDateString();

    // Rotate if date changed
    if (today !== this.currentDate) {
      this.closeStream();
      this.currentDate = today;
    }

    if (!this.writeStream) {
      try {
        const filePath = this.getLogFilePath(this.currentDate);
        this.writeStream = fs.createWriteStream(filePath, { flags: 'a' });
        this.writeStream.on('error', (error) => {
          logger.error('Audit write stream error', error);
          this.writeStream = null;
        });
      } catch (error) {
        logger.error('Failed to create audit write stream', error as Error);
        return null;
      }
    }

    return this.writeStream;
  }

  /**
   * Close the current write stream
   */
  private closeStream(): void {
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
  }

  /**
   * Sanitize input for logging (mask sensitive data, truncate large values)
   */
  private sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string') {
        // Mask sensitive data
        let sanitizedValue = maskSensitiveData(value);
        // Truncate long strings
        if (sanitizedValue.length > 1000) {
          sanitizedValue = sanitizedValue.substring(0, 1000) + '...[truncated]';
        }
        sanitized[key] = sanitizedValue;
      } else if (value && typeof value === 'object') {
        // Recursively sanitize nested objects
        sanitized[key] = this.sanitizeInput(value as Record<string, unknown>);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Truncate output if too long
   */
  private truncateOutput(output: string): string {
    if (output.length > this.maxOutputLength) {
      return output.substring(0, this.maxOutputLength) + '...[truncated]';
    }
    return output;
  }

  /**
   * Log an audit entry
   *
   * @param entry - Partial audit entry (timestamp will be added)
   */
  log(entry: Omit<AuditEntry, 'timestamp' | 'timestampISO'>): void {
    if (!this.enabled) {
      return;
    }

    const now = new Date();
    const fullEntry: AuditEntry = {
      ...entry,
      timestamp: now.getTime(),
      timestampISO: now.toISOString(),
      input: this.sanitizeInput(entry.input),
      output: entry.output ? maskSensitiveData(this.truncateOutput(entry.output)) : undefined,
    };

    const stream = this.getWriteStream();
    if (stream) {
      try {
        stream.write(JSON.stringify(fullEntry) + '\n');
        logger.debug('Audit entry logged', {
          eventType: entry.eventType,
          toolName: entry.toolName,
          success: entry.success,
        });
      } catch (error) {
        logger.error('Failed to write audit entry', error as Error);
      }
    }
  }

  /**
   * Log tool usage
   */
  logToolUsage(params: {
    sessionId: string;
    toolName: string;
    input: Record<string, unknown>;
    output?: string;
    duration: number;
    success: boolean;
    error?: string;
    securityFlags?: string[];
    riskLevel?: AuditEntry['riskLevel'];
  }): void {
    this.log({
      eventType: 'tool_usage',
      ...params,
    });
  }

  /**
   * Log command execution
   */
  logCommandExecution(params: {
    sessionId: string;
    command: string;
    exitCode: number;
    duration: number;
    securityFlags?: string[];
    riskLevel?: AuditEntry['riskLevel'];
  }): void {
    this.log({
      eventType: 'command_execution',
      sessionId: params.sessionId,
      toolName: 'bash',
      input: { command: params.command },
      output: `exit code: ${params.exitCode}`,
      duration: params.duration,
      success: params.exitCode === 0,
      securityFlags: params.securityFlags,
      riskLevel: params.riskLevel,
    });
  }

  /**
   * Log security incident
   */
  logSecurityIncident(params: {
    sessionId: string;
    toolName: string;
    incident: string;
    details: Record<string, unknown>;
    riskLevel: AuditEntry['riskLevel'];
  }): void {
    this.log({
      eventType: 'security_incident',
      sessionId: params.sessionId,
      toolName: params.toolName,
      input: params.details,
      output: params.incident,
      duration: 0,
      success: false,
      riskLevel: params.riskLevel,
      securityFlags: ['security_incident'],
    });
  }

  /**
   * Query audit logs
   *
   * @param options - Query options
   * @returns Query result with matching entries
   */
  async query(options: AuditQueryOptions = {}): Promise<AuditQueryResult> {
    const {
      startTime,
      endTime,
      sessionId,
      eventType,
      toolName,
      failedOnly,
      securityOnly,
      limit = 100,
      offset = 0,
    } = options;

    const entries: AuditEntry[] = [];
    const startDate = startTime ? new Date(startTime) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const endDate = endTime ? new Date(endTime) : new Date();

    // Get list of log files in date range
    const logFiles = this.getLogFilesInRange(startDate, endDate);

    for (const filePath of logFiles) {
      if (!fs.existsSync(filePath)) {
        continue;
      }

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as AuditEntry;

            // Apply filters
            if (startTime && entry.timestamp < startTime) continue;
            if (endTime && entry.timestamp > endTime) continue;
            if (sessionId && entry.sessionId !== sessionId) continue;
            if (eventType && entry.eventType !== eventType) continue;
            if (toolName && entry.toolName !== toolName) continue;
            if (failedOnly && entry.success) continue;
            if (securityOnly && entry.eventType !== 'security_incident') continue;

            entries.push(entry);
          } catch {
            // Skip malformed lines
          }
        }
      } catch (error) {
        logger.error('Failed to read audit file', error as Error, { filePath });
      }
    }

    // Sort by timestamp descending
    entries.sort((a, b) => b.timestamp - a.timestamp);

    // Apply pagination
    const total = entries.length;
    const paginatedEntries = entries.slice(offset, offset + limit);

    return {
      entries: paginatedEntries,
      total,
      hasMore: offset + limit < total,
    };
  }

  /**
   * Get log files in a date range
   */
  private getLogFilesInRange(startDate: Date, endDate: Date): string[] {
    const files: string[] = [];
    const current = new Date(startDate);

    while (current <= endDate) {
      files.push(this.getLogFilePath(this.getDateString(current)));
      current.setDate(current.getDate() + 1);
    }

    return files;
  }

  /**
   * Get statistics for a time period
   */
  async getStatistics(options: { startTime?: number; endTime?: number; sessionId?: string } = {}): Promise<{
    totalEvents: number;
    eventsByType: Record<string, number>;
    eventsByTool: Record<string, number>;
    successRate: number;
    securityIncidents: number;
    riskLevelDistribution: Record<string, number>;
  }> {
    const result = await this.query({
      ...options,
      limit: 10000,
    });

    const stats = {
      totalEvents: result.total,
      eventsByType: {} as Record<string, number>,
      eventsByTool: {} as Record<string, number>,
      successRate: 0,
      securityIncidents: 0,
      riskLevelDistribution: {} as Record<string, number>,
    };

    let successCount = 0;

    for (const entry of result.entries) {
      // Count by type
      stats.eventsByType[entry.eventType] = (stats.eventsByType[entry.eventType] || 0) + 1;

      // Count by tool
      stats.eventsByTool[entry.toolName] = (stats.eventsByTool[entry.toolName] || 0) + 1;

      // Success count
      if (entry.success) {
        successCount++;
      }

      // Security incidents
      if (entry.eventType === 'security_incident') {
        stats.securityIncidents++;
      }

      // Risk level distribution
      if (entry.riskLevel) {
        stats.riskLevelDistribution[entry.riskLevel] =
          (stats.riskLevelDistribution[entry.riskLevel] || 0) + 1;
      }
    }

    stats.successRate = result.total > 0 ? successCount / result.total : 0;

    return stats;
  }

  /**
   * Clean up old audit logs
   *
   * @param retentionDays - Number of days to retain logs (default: 30)
   */
  async cleanup(retentionDays = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    let deletedCount = 0;

    try {
      const files = fs.readdirSync(this.auditDir);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;

        const dateStr = file.replace('.jsonl', '');
        const fileDate = new Date(dateStr);

        if (fileDate < cutoffDate) {
          const filePath = path.join(this.auditDir, file);
          fs.unlinkSync(filePath);
          deletedCount++;
          logger.info('Deleted old audit log', { file });
        }
      }
    } catch (error) {
      logger.error('Failed to cleanup audit logs', error as Error);
    }

    return deletedCount;
  }

  /**
   * Disable audit logging
   */
  disable(): void {
    this.enabled = false;
    this.closeStream();
  }

  /**
   * Enable audit logging
   */
  enable(): void {
    this.enabled = true;
    this.ensureAuditDir();
  }

  /**
   * Check if audit logging is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Close the audit logger
   */
  close(): void {
    this.closeStream();
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let auditLoggerInstance: AuditLogger | null = null;

/**
 * Get or create audit logger instance
 */
export function getAuditLogger(): AuditLogger {
  if (!auditLoggerInstance) {
    auditLoggerInstance = new AuditLogger();
  }
  return auditLoggerInstance;
}

/**
 * Reset audit logger instance (for testing)
 */
export function resetAuditLogger(): void {
  if (auditLoggerInstance) {
    auditLoggerInstance.close();
  }
  auditLoggerInstance = null;
}
