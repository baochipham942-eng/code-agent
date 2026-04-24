import { beforeEach, describe, expect, it } from 'vitest';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

describe('composerStore', () => {
  beforeEach(() => {
    useComposerStore.setState({
      workingDirectory: null,
      routingMode: 'auto',
      targetAgentIds: [],
      browserSessionMode: 'none',
      selectedSkillIds: [],
      selectedConnectorIds: [],
      selectedMcpServerIds: [],
      hydratedSessionId: null,
    });
    useAppStore.setState({ previewTabs: [], activePreviewTabId: null });
  });

  it('hydrates from session and resets routing state on session switch', () => {
    useComposerStore.getState().setRoutingMode('direct');
    useComposerStore.getState().setTargetAgentIds(['agent-1']);

    useComposerStore.getState().hydrateFromSession('session-1', '/tmp/work');

    const state = useComposerStore.getState();
    expect(state.hydratedSessionId).toBe('session-1');
    expect(state.workingDirectory).toBe('/tmp/work');
    expect(state.routingMode).toBe('auto');
    expect(state.targetAgentIds).toEqual([]);
  });

  it('updates working directory when hydrating the same session', () => {
    useComposerStore.getState().hydrateFromSession('session-1', '/tmp/old');
    useComposerStore.getState().hydrateFromSession('session-1', '/tmp/new');

    expect(useComposerStore.getState().workingDirectory).toBe('/tmp/new');
  });

  it('clears target agents when routing mode leaves direct', () => {
    useComposerStore.getState().setRoutingMode('direct');
    useComposerStore.getState().setTargetAgentIds(['agent-1', 'agent-2']);

    useComposerStore.getState().setRoutingMode('parallel');

    const state = useComposerStore.getState();
    expect(state.routingMode).toBe('parallel');
    expect(state.targetAgentIds).toEqual([]);
  });

  it('builds context with routing and working directory snapshot', () => {
    useComposerStore.getState().hydrateFromSession('session-1', '/tmp/work');
    useComposerStore.getState().setRoutingMode('direct');
    useComposerStore.getState().setTargetAgentIds(['agent-1', 'agent-1']);
    useComposerStore.getState().setBrowserSessionMode('desktop');
    useComposerStore.getState().setSelectedSkillIds(['review-skill', 'review-skill']);
    useComposerStore.getState().setSelectedConnectorIds(['mail', 'mail']);
    useComposerStore.getState().setSelectedMcpServerIds(['github', 'github']);

    expect(useComposerStore.getState().buildContext()).toEqual({
      workingDirectory: '/tmp/work',
      routing: {
        mode: 'direct',
        targetAgentIds: ['agent-1'],
      },
      executionIntent: {
        browserSessionMode: 'desktop',
        preferBrowserSession: true,
        preferDesktopContext: true,
        allowBrowserAutomation: false,
      },
      selectedSkillIds: ['review-skill'],
      selectedConnectorIds: ['mail'],
      selectedMcpServerIds: ['github'],
    });
  });

  it('resets browser session mode when switching sessions', () => {
    useComposerStore.getState().setBrowserSessionMode('managed');

    useComposerStore.getState().hydrateFromSession('session-2', '/tmp/work');

    expect(useComposerStore.getState().browserSessionMode).toBe('none');
  });

  it('applies a persisted session workbench preset without rebinding the current session', () => {
    useComposerStore.getState().hydrateFromSession('current-session', '/tmp/current');

    useComposerStore.getState().applySessionWorkbenchPreset({
      workingDirectory: '/tmp/reused',
      workbenchSnapshot: {
        summary: 'review + browser',
        labels: ['review', 'browser'],
        recentToolNames: ['browser_action'],
        routingMode: 'parallel',
        skillIds: ['snapshot-skill'],
        connectorIds: ['snapshot-connector'],
        mcpServerIds: ['snapshot-mcp'],
      },
      workbenchProvenance: {
        capturedAt: Date.now(),
        workingDirectory: '/tmp/reused',
        routingMode: 'direct',
        targetAgentIds: ['agent-1', 'agent-1'],
        selectedSkillIds: ['review-skill', 'review-skill'],
        selectedConnectorIds: ['mail', 'mail'],
        selectedMcpServerIds: ['github', 'github'],
        executionIntent: {
          browserSessionMode: 'managed',
          preferBrowserSession: true,
          allowBrowserAutomation: true,
        },
      },
    });

    expect(useComposerStore.getState()).toMatchObject({
      hydratedSessionId: 'current-session',
      workingDirectory: '/tmp/reused',
      routingMode: 'direct',
      targetAgentIds: ['agent-1'],
      browserSessionMode: 'managed',
      selectedSkillIds: ['review-skill'],
      selectedConnectorIds: ['mail'],
      selectedMcpServerIds: ['github'],
    });
  });

  it('downgrades incomplete direct snapshot presets and falls back to snapshot capability ids', () => {
    useComposerStore.getState().hydrateFromSession('current-session', '/tmp/current');
    useComposerStore.getState().setRoutingMode('direct');
    useComposerStore.getState().setTargetAgentIds(['agent-existing']);

    useComposerStore.getState().applySessionWorkbenchPreset({
      workingDirectory: undefined,
      workbenchSnapshot: {
        summary: 'browser scrape',
        labels: ['browser'],
        recentToolNames: ['browser_action'],
        routingMode: 'direct',
        skillIds: ['snapshot-skill', 'snapshot-skill'],
        connectorIds: ['mail', 'mail'],
        mcpServerIds: ['github', 'github'],
      },
      workbenchProvenance: undefined,
    });

    expect(useComposerStore.getState()).toMatchObject({
      hydratedSessionId: 'current-session',
      workingDirectory: '/tmp/current',
      routingMode: 'auto',
      targetAgentIds: [],
      browserSessionMode: 'none',
      selectedSkillIds: ['snapshot-skill'],
      selectedConnectorIds: ['mail'],
      selectedMcpServerIds: ['github'],
    });
  });

  it('applies a named workbench preset asset to composer state', () => {
    useComposerStore.getState().hydrateFromSession('current-session', '/tmp/current');

    useComposerStore.getState().applyWorkbenchPreset({
      version: 1,
      id: 'preset-1',
      name: 'Review Browser Preset',
      createdAt: 100,
      updatedAt: 100,
      source: { kind: 'manual' },
      context: {
        workingDirectory: '/tmp/preset',
        routingMode: 'direct',
        targetAgentIds: ['agent-1', 'agent-1'],
        browserSessionMode: 'desktop',
        selectedSkillIds: ['review-skill', 'review-skill'],
        selectedConnectorIds: ['mail', 'mail'],
        selectedMcpServerIds: ['github', 'github'],
        executionIntent: {
          browserSessionMode: 'desktop',
          preferBrowserSession: true,
          preferDesktopContext: true,
        },
      },
    });

    expect(useComposerStore.getState()).toMatchObject({
      hydratedSessionId: 'current-session',
      workingDirectory: '/tmp/preset',
      routingMode: 'direct',
      targetAgentIds: ['agent-1'],
      browserSessionMode: 'desktop',
      selectedSkillIds: ['review-skill'],
      selectedConnectorIds: ['mail'],
      selectedMcpServerIds: ['github'],
    });
  });

  it('preserves the current working directory when applying a capability-only preset', () => {
    useComposerStore.getState().hydrateFromSession('current-session', '/tmp/current');

    useComposerStore.getState().applyWorkbenchPreset({
      workingDirectory: null,
      routingMode: 'auto',
      targetAgentIds: [],
      browserSessionMode: 'none',
      selectedSkillIds: ['review-skill'],
      selectedConnectorIds: [],
      selectedMcpServerIds: [],
    });

    expect(useComposerStore.getState()).toMatchObject({
      workingDirectory: '/tmp/current',
      routingMode: 'auto',
      selectedSkillIds: ['review-skill'],
    });
  });

  it('applies a workbench recipe by merging step contexts', () => {
    useComposerStore.getState().hydrateFromSession('current-session', '/tmp/current');

    useComposerStore.getState().applyWorkbenchRecipe({
      version: 1,
      id: 'recipe-1',
      name: 'Browser then connector',
      createdAt: 100,
      updatedAt: 100,
      source: { kind: 'manual' },
      steps: [
        {
          id: 'step-1',
          name: 'Browser',
          context: {
            workingDirectory: '/tmp/browser',
            routingMode: 'direct',
            targetAgentIds: ['agent-1', 'agent-1'],
            browserSessionMode: 'managed',
            selectedSkillIds: ['review-skill'],
            selectedConnectorIds: [],
            selectedMcpServerIds: [],
          },
        },
        {
          id: 'step-2',
          name: 'Connector',
          context: {
            workingDirectory: null,
            routingMode: 'auto',
            targetAgentIds: [],
            browserSessionMode: 'none',
            selectedSkillIds: ['review-skill', 'research-skill'],
            selectedConnectorIds: ['mail', 'mail'],
            selectedMcpServerIds: ['github'],
          },
        },
      ],
    });

    expect(useComposerStore.getState()).toMatchObject({
      hydratedSessionId: 'current-session',
      workingDirectory: '/tmp/browser',
      routingMode: 'direct',
      targetAgentIds: ['agent-1'],
      browserSessionMode: 'managed',
      selectedSkillIds: ['review-skill', 'research-skill'],
      selectedConnectorIds: ['mail'],
      selectedMcpServerIds: ['github'],
    });
  });

  it('injects livePreviewSelection from active liveDev tab (D8 P2)', () => {
    useAppStore.setState({
      previewTabs: [
        {
          id: 'live-1',
          path: 'http://localhost:5175/',
          content: '',
          savedContent: '',
          mode: 'preview',
          lastActivatedAt: 1,
          isLoaded: true,
          kind: 'liveDev',
          devServerUrl: 'http://localhost:5175/',
          selectedElement: {
            file: '/Users/linchen/work/app/src/Hero.tsx',
            line: 42,
            column: 7,
            tag: 'button',
            text: 'Clicked 0 times',
            rect: { x: 100, y: 200, width: 80, height: 32 },
            componentName: 'HeroCTA',
          },
        },
      ],
      activePreviewTabId: 'live-1',
    });

    const context = useComposerStore.getState().buildContext();
    expect(context?.livePreviewSelection).toEqual({
      location: {
        file: '/Users/linchen/work/app/src/Hero.tsx',
        line: 42,
        column: 7,
      },
      tag: 'button',
      text: 'Clicked 0 times',
      rect: { x: 100, y: 200, width: 80, height: 32 },
      componentName: 'HeroCTA',
    });
  });

  it('omits livePreviewSelection when active tab is a file tab (not liveDev)', () => {
    useAppStore.setState({
      previewTabs: [
        {
          id: 'file-1',
          path: '/x/y.tsx',
          content: '',
          savedContent: '',
          mode: 'preview',
          lastActivatedAt: 1,
          isLoaded: true,
          kind: 'file',
          selectedElement: null,
        },
      ],
      activePreviewTabId: 'file-1',
    });
    const context = useComposerStore.getState().buildContext();
    expect(context?.livePreviewSelection).toBeUndefined();
  });

  it('omits livePreviewSelection when no element is selected', () => {
    useAppStore.setState({
      previewTabs: [
        {
          id: 'live-1',
          path: 'http://localhost:5175/',
          content: '',
          savedContent: '',
          mode: 'preview',
          lastActivatedAt: 1,
          isLoaded: true,
          kind: 'liveDev',
          devServerUrl: 'http://localhost:5175/',
          selectedElement: null,
        },
      ],
      activePreviewTabId: 'live-1',
    });
    const context = useComposerStore.getState().buildContext();
    expect(context?.livePreviewSelection).toBeUndefined();
  });
});
