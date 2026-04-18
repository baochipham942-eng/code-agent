import { describe, expect, it } from 'vitest';
import { deriveSessionWorkbenchSnapshot } from '../../../src/shared/contract/sessionWorkspace';

describe('deriveSessionWorkbenchSnapshot', () => {
  it('prefers latest workbench metadata when explaining the session surface', () => {
    const snapshot = deriveSessionWorkbenchSnapshot([
      {
        timestamp: 100,
        metadata: {
          workbench: {
            workingDirectory: '/repo/code-agent',
            routingMode: 'direct',
            targetAgentNames: ['BrowserWorker'],
            selectedConnectorIds: ['mail'],
            executionIntent: {
              browserSessionMode: 'managed',
            },
          },
        },
        toolCalls: [],
        toolResults: [],
      },
    ]);

    expect(snapshot.primarySurface).toBe('browser');
    expect(snapshot.evidenceSource).toBe('message_metadata');
    expect(snapshot.workspaceLabel).toBe('code-agent');
    expect(snapshot.summary).toContain('Browser(托管)');
    expect(snapshot.summary).toContain('Direct BrowserWorker');
    expect(snapshot.summary).toContain('连接器 mail');
    expect(snapshot.labels).toContain('工作区');
    expect(snapshot.labels).toContain('Browser');
    expect(snapshot.labels).toContain('连接器:mail');
    expect(snapshot.connectorIds).toEqual(['mail']);
  });

  it('falls back to tool history when no persisted workbench metadata exists', () => {
    const snapshot = deriveSessionWorkbenchSnapshot([
      {
        timestamp: 100,
        toolCalls: [
          {
            id: 'tool-1',
            name: 'computer_use',
            arguments: {
              action: 'smart_click',
            },
          },
        ],
        toolResults: [],
      },
    ], {
      workingDirectory: '/repo/code-agent',
    });

    expect(snapshot.primarySurface).toBe('browser');
    expect(snapshot.evidenceSource).toBe('tool_history');
    expect(snapshot.summary).toContain('Browser');
    expect(snapshot.summary).toContain('工作区');
    expect(snapshot.labels).toContain('工作区');
    expect(snapshot.labels).toContain('Browser');
    expect(snapshot.recentToolNames).toEqual(['computer_use']);
  });
});
