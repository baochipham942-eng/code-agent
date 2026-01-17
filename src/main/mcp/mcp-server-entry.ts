#!/usr/bin/env node
// ============================================================================
// Code Agent MCP Server - Standalone entry point
// Run this as: npx ts-node src/main/mcp/mcp-server-entry.ts
// Or after build: node dist/main/mcp/mcp-server-entry.js
// ============================================================================

import { CodeAgentMCPServer } from './MCPServer.js';

async function main() {
  console.error('[MCP Server Entry] Starting Code Agent MCP Server...');

  const server = new CodeAgentMCPServer();

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.error('[MCP Server Entry] Received SIGINT, shutting down...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('[MCP Server Entry] Received SIGTERM, shutting down...');
    await server.stop();
    process.exit(0);
  });

  try {
    await server.start();
    console.error('[MCP Server Entry] Server started successfully');
  } catch (error) {
    console.error('[MCP Server Entry] Failed to start server:', error);
    process.exit(1);
  }
}

main();
