// ============================================================================
// MCP Elicitation Handler - Bridge MCP server elicitation to UI
//
// When an MCP server tool needs user input (e.g. OAuth consent, configuration
// choice, confirmation), it sends an `elicitation/create` request back to the
// client. This module:
// 1. Registers a handler on the SDK Client for `elicitation/create`
// 2. Translates the MCP form schema into a UI prompt sent via IPC
// 3. Waits for the user response and returns it as an ElicitResult
// ============================================================================

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BrowserWindow, ipcMain } from '../platform';
import { IPC_CHANNELS } from '../../shared/ipc';
import { INTERACTION_TIMEOUTS } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';
import type {
  MCPElicitationRequest,
  MCPElicitationResponse,
  ElicitationFieldSchema,
} from '../../shared/types';

const logger = createLogger('MCPElicitation');

// Pending elicitation requests awaiting user response
const pendingElicitations = new Map<string, {
  resolve: (response: MCPElicitationResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();

// Register IPC response handler once
let handlerRegistered = false;

function registerElicitationResponseHandler(): void {
  if (handlerRegistered) return;
  handlerRegistered = true;

  ipcMain.handle(
    IPC_CHANNELS.MCP_ELICITATION_RESPONSE,
    async (_event, response: MCPElicitationResponse) => {
      const pending = pendingElicitations.get(response.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingElicitations.delete(response.requestId);
        pending.resolve(response);
        logger.info('Received elicitation response', {
          requestId: response.requestId,
          action: response.action,
        });
      } else {
        logger.warn('Received elicitation response for unknown request', {
          requestId: response.requestId,
        });
      }
    },
  );
}

/**
 * Register the elicitation request handler on an MCP SDK Client.
 * Must be called BEFORE `client.connect(transport)`.
 *
 * @param client - The MCP SDK Client instance
 * @param serverName - Human-readable server name (for logging and UI)
 */
export function registerElicitationHandler(
  client: Client,
  serverName: string,
): void {
  registerElicitationResponseHandler();

  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    const params = request.params;

    // Only support form mode; URL mode requires opening a browser which is
    // a different UX flow (not implemented yet)
    if (params.mode === 'url') {
      logger.warn('URL-mode elicitation not supported', { serverName });
      return { action: 'decline' as const };
    }

    // Form mode (default)
    const formParams = params as {
      message: string;
      requestedSchema?: {
        properties: Record<string, ElicitationFieldSchema>;
        required?: string[];
      };
    };

    const requestId = `elicit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const elicitationRequest: MCPElicitationRequest = {
      id: requestId,
      serverName,
      message: formParams.message,
      fields: formParams.requestedSchema?.properties || {},
      required: formParams.requestedSchema?.required,
      timestamp: Date.now(),
    };

    logger.info('Elicitation request from MCP server', {
      serverName,
      requestId,
      fieldCount: Object.keys(elicitationRequest.fields).length,
    });

    // Send to renderer via IPC
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) {
      // CLI mode: no UI available, decline the request
      logger.warn('No window available for elicitation, declining', { serverName });
      return { action: 'decline' as const };
    }

    mainWindow.webContents.send(IPC_CHANNELS.MCP_ELICITATION_REQUEST, elicitationRequest);

    // Desktop notification when app is not focused
    try {
      const { notificationService } = await import('../services/infra/notificationService');
      notificationService.notifyNeedsInput({
        sessionId: '',
        title: 'MCP 服务器需要输入',
        body: formParams.message,
      });
    } catch { /* ignore */ }

    // Wait for user response with timeout
    const timeoutMs = INTERACTION_TIMEOUTS.MCP_ELICITATION;

    try {
      const response = await new Promise<MCPElicitationResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingElicitations.delete(requestId);
          logger.warn('Elicitation timed out', { serverName, requestId, timeoutMs });
          reject(new Error('Elicitation timeout - no response from user'));
        }, timeoutMs);

        pendingElicitations.set(requestId, { resolve, reject, timeout });
      });

      // Map to MCP ElicitResult format
      return {
        action: response.action,
        content: response.content,
      };
    } catch {
      // Timeout or error — return cancel to MCP server
      return { action: 'cancel' as const };
    }
  });

  logger.info('Registered elicitation handler', { serverName });
}
