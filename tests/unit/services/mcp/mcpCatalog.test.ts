import { describe, expect, it } from 'vitest';
import {
  MCP_CATEGORIES,
  RECOMMENDED_MCP_SERVERS,
  findRecommendedMcpServer,
  groupRecommendedMcpServersByCategory,
} from '../../../../src/shared/constants/mcpCatalog';
import { getBuiltinConfig } from '../../../../src/main/services/cloud/builtinConfig';
import { getEntryAction } from '../../../../src/renderer/components/features/settings/tabs/McpDiscoverTab';

describe('recommended MCP catalog integrity', () => {
  const categoryIds = new Set(MCP_CATEGORIES.map((category) => category.id));
  const builtinCloudServerIds = new Set(getBuiltinConfig().mcpServers.map((server) => server.id));

  it('has unique server ids', () => {
    const ids = RECOMMENDED_MCP_SERVERS.map((server) => server.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry uses a defined category', () => {
    for (const server of RECOMMENDED_MCP_SERVERS) {
      expect(
        categoryIds.has(server.category),
        `server "${server.id}" uses unknown category "${server.category}"`
      ).toBe(true);
    }
  });

  it('every builtin entry exists in cloud builtin MCP config', () => {
    for (const server of RECOMMENDED_MCP_SERVERS) {
      if (server.builtin) {
        expect(
          builtinCloudServerIds.has(server.id),
          `builtin entry "${server.id}" not found in BUILTIN_MCP_SERVERS (cloud builtinConfig)`
        ).toBe(true);
      }
    }
  });

  it('every non-builtin entry has a valid connection template', () => {
    for (const server of RECOMMENDED_MCP_SERVERS) {
      if (server.builtin) continue;
      expect(server.connection, `entry "${server.id}" missing connection template`).toBeDefined();
      const connection = server.connection!;
      if (connection.type === 'stdio') {
        expect(connection.command, `stdio entry "${server.id}" missing command`).toBeTruthy();
      } else {
        expect(connection.url, `${connection.type} entry "${server.id}" missing url`).toBeTruthy();
      }
    }
  });

  it('stdio entries with empty env placeholders declare them as required credentials', () => {
    for (const server of RECOMMENDED_MCP_SERVERS) {
      const env = server.connection?.env ?? {};
      const placeholderKeys = Object.entries(env)
        .filter(([, value]) => value === '')
        .map(([key]) => key);
      for (const key of placeholderKeys) {
        expect(
          server.requiredCredentials ?? [],
          `entry "${server.id}" env placeholder "${key}" not declared in requiredCredentials`
        ).toContain(key);
      }
    }
  });

  it('groups servers by category preserving MCP_CATEGORIES order', () => {
    const groups = groupRecommendedMcpServersByCategory();
    for (const group of groups) {
      expect(group.servers.length).toBeGreaterThan(0);
    }
    const groupOrder = groups.map((group) => group.category.id);
    const expectedOrder = MCP_CATEGORIES.filter((category) =>
      RECOMMENDED_MCP_SERVERS.some((server) => server.category === category.id)
    ).map((category) => category.id);
    expect(groupOrder).toEqual(expectedOrder);
  });

  it('findRecommendedMcpServer resolves all entries', () => {
    for (const server of RECOMMENDED_MCP_SERVERS) {
      expect(findRecommendedMcpServer(server.id)).toEqual(server);
    }
    expect(findRecommendedMcpServer('nonexistent')).toBeUndefined();
  });
});

describe('discover tab entry actions', () => {
  const builtinEntry = RECOMMENDED_MCP_SERVERS.find((server) => server.builtin)!;
  const quickConnectEntry = RECOMMENDED_MCP_SERVERS.find(
    (server) => !server.builtin && !server.requiredCredentials?.length
  )!;
  const credentialEntry = RECOMMENDED_MCP_SERVERS.find(
    (server) => !server.builtin && (server.requiredCredentials?.length ?? 0) > 0
  )!;

  it('builtin entry: enabled when in enabled set, otherwise enable-builtin', () => {
    expect(getEntryAction(builtinEntry, new Set([builtinEntry.id]), new Set([builtinEntry.id]))).toBe('enabled');
    expect(getEntryAction(builtinEntry, new Set([builtinEntry.id]), new Set())).toBe('enable-builtin');
  });

  it('non-builtin entry already configured shows connected', () => {
    expect(getEntryAction(quickConnectEntry, new Set([quickConnectEntry.id]), new Set())).toBe('connected');
  });

  it('credential-free entry offers quick connect', () => {
    expect(getEntryAction(quickConnectEntry, new Set(), new Set())).toBe('quick-connect');
  });

  it('credential-required entry opens config editor', () => {
    expect(getEntryAction(credentialEntry, new Set(), new Set())).toBe('connect-with-config');
  });
});
