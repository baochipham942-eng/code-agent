#!/usr/bin/env npx tsx
// ============================================================================
// Headless Test Script - Test main agent flow without GUI
// ============================================================================

/**
 * This script tests the core agent functionality without requiring Electron GUI.
 * It simulates the main process flow: initialization -> message sending -> response.
 *
 * Usage: npx tsx scripts/headless-test.ts
 */

import path from 'path';
import fs from 'fs/promises';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Mock electron app for ConfigService
const mockApp = {
  getPath: (name: string) => {
    if (name === 'userData') {
      return path.join(process.cwd(), '.test-data');
    }
    return process.cwd();
  },
};

// Inject mock before importing modules that use electron
(global as any).mockElectronApp = mockApp;

// Patch require to intercept electron imports
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'electron') {
    return {
      app: mockApp,
      ipcMain: {
        handle: () => {},
        on: () => {},
      },
      BrowserWindow: class {},
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      },
    };
  }
  return originalRequire.apply(this, arguments);
};

// Now import our modules
import { GenerationManager } from '../src/main/generation/GenerationManager.js';
import { ModelRouter } from '../src/main/model/ModelRouter.js';
import { ToolRegistry } from '../src/main/tools/ToolRegistry.js';
import { initDatabase, getDatabase } from '../src/main/services/DatabaseService.js';
import { getSessionManager } from '../src/main/services/SessionManager.js';

// ----------------------------------------------------------------------------
// Test Configuration
// ----------------------------------------------------------------------------

interface TestConfig {
  apiKey?: string;
  provider: string;
  model: string;
  generation: 'gen1' | 'gen2' | 'gen3' | 'gen4';
  workingDirectory: string;
  testMessage: string;
}

const DEFAULT_CONFIG: TestConfig = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  generation: 'gen3',
  workingDirectory: process.cwd(),
  testMessage: '你好，请简单介绍一下你自己',
};

// ----------------------------------------------------------------------------
// Test Runner
// ----------------------------------------------------------------------------

class HeadlessTestRunner {
  private config: TestConfig;
  private generationManager: GenerationManager;
  private modelRouter: ModelRouter;
  private toolRegistry: ToolRegistry;
  private events: any[] = [];

  constructor(config: Partial<TestConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.generationManager = new GenerationManager();
    this.modelRouter = new ModelRouter();
    this.toolRegistry = new ToolRegistry();
  }

  async initialize(): Promise<void> {
    console.log('\n========================================');
    console.log('Code Agent Headless Test');
    console.log('========================================\n');

    // Load API key from environment or .env file
    await this.loadApiKey();

    if (!this.config.apiKey) {
      throw new Error(
        'No API key found. Set DEEPSEEK_API_KEY environment variable or create .env file'
      );
    }

    // Switch to configured generation
    this.generationManager.switchGeneration(this.config.generation);
    const generation = this.generationManager.getCurrentGeneration();

    console.log('Configuration:');
    console.log(`  Provider: ${this.config.provider}`);
    console.log(`  Model: ${this.config.model}`);
    console.log(`  Generation: ${generation.name} (${generation.version})`);
    console.log(`  Tools: ${generation.tools.join(', ')}`);
    console.log(`  Working Directory: ${this.config.workingDirectory}`);
    console.log('');
  }

  private async loadApiKey(): Promise<void> {
    // Try environment variable first
    if (process.env.DEEPSEEK_API_KEY) {
      this.config.apiKey = process.env.DEEPSEEK_API_KEY;
      console.log('API key loaded from environment variable');
      return;
    }

    // Try .env file
    try {
      const envPath = path.join(process.cwd(), '.env');
      const envContent = await fs.readFile(envPath, 'utf-8');
      const match = envContent.match(/DEEPSEEK_API_KEY=["']?([^"'\s\n]+)["']?/);
      if (match) {
        this.config.apiKey = match[1].trim();
        console.log('API key loaded from .env file');
        return;
      }
    } catch {
      // .env file doesn't exist
    }

    console.log('Warning: No API key found');
  }

  async runTest(): Promise<void> {
    console.log('========================================');
    console.log('Running Test: Simple Message');
    console.log('========================================\n');

    const generation = this.generationManager.getCurrentGeneration();

    // Build messages array
    const messages = [
      {
        role: 'system',
        content: generation.systemPrompt,
      },
      {
        role: 'user',
        content: this.config.testMessage,
      },
    ];

    // Get available tools
    const tools = this.toolRegistry.getForGeneration(this.config.generation);
    const toolDefinitions = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    console.log(`Sending message: "${this.config.testMessage}"`);
    console.log(`Using ${toolDefinitions.length} tools\n`);

    try {
      const startTime = Date.now();

      // Call model
      const response = await this.modelRouter.inference(
        messages,
        toolDefinitions,
        {
          provider: this.config.provider,
          model: this.config.model,
          apiKey: this.config.apiKey,
          temperature: 0.7,
          maxTokens: 2048,
        },
        (chunk) => {
          process.stdout.write(chunk);
        }
      );

      const elapsed = Date.now() - startTime;

      console.log('\n\n----------------------------------------');
      console.log('Response Details:');
      console.log(`  Type: ${response.type}`);
      console.log(`  Time: ${elapsed}ms`);

      if (response.type === 'text') {
        console.log(`  Content length: ${response.content?.length || 0} chars`);
      } else if (response.type === 'tool_use' && response.toolCalls) {
        console.log(`  Tool calls: ${response.toolCalls.length}`);
        for (const tc of response.toolCalls) {
          console.log(`    - ${tc.name}(${JSON.stringify(tc.arguments)})`);
        }
      }

      console.log('\n========================================');
      console.log('Test PASSED');
      console.log('========================================\n');
    } catch (error) {
      console.error('\n========================================');
      console.error('Test FAILED');
      console.error('========================================');
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }

  async runToolTest(): Promise<void> {
    console.log('\n========================================');
    console.log('Running Test: Tool Call Flow');
    console.log('========================================\n');

    const generation = this.generationManager.getCurrentGeneration();
    const testPrompt = '请列出当前目录下的所有文件';

    const messages = [
      {
        role: 'system',
        content: generation.systemPrompt,
      },
      {
        role: 'user',
        content: testPrompt,
      },
    ];

    const tools2 = this.toolRegistry.getForGeneration(this.config.generation);
    const toolDefinitions2 = tools2.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    console.log(`Sending message: "${testPrompt}"`);
    console.log('This should trigger a tool call (bash or list_directory)\n');

    try {
      const response = await this.modelRouter.inference(
        messages,
        toolDefinitions2,
        {
          provider: this.config.provider,
          model: this.config.model,
          apiKey: this.config.apiKey,
          temperature: 0.7,
          maxTokens: 2048,
        }
      );

      if (response.type === 'tool_use' && response.toolCalls?.length) {
        console.log('Tool calls triggered:');
        for (const tc of response.toolCalls) {
          console.log(`  - ${tc.name}(${JSON.stringify(tc.arguments)})`);
        }
        console.log('\n========================================');
        console.log('Tool Test PASSED');
        console.log('========================================\n');
      } else {
        console.log('Response type:', response.type);
        console.log('Content:', response.content?.substring(0, 200));
        console.log('\nNote: Model did not trigger tool call (may be expected behavior)');
      }
    } catch (error) {
      console.error('Tool test error:', error);
      throw error;
    }
  }

  async runSessionTest(): Promise<void> {
    console.log('\n========================================');
    console.log('Running Test: Session Management');
    console.log('========================================\n');

    try {
      // Initialize database
      console.log('1. Initializing database...');
      await initDatabase();
      const db = getDatabase();
      console.log('   Database initialized');

      // Get session manager
      const sessionManager = getSessionManager();

      // Create a new session
      console.log('2. Creating new session...');
      const session = await sessionManager.createSession({
        title: 'Test Session',
        generationId: this.config.generation,
        modelConfig: {
          provider: this.config.provider as any,
          model: this.config.model,
        },
        workingDirectory: this.config.workingDirectory,
      });
      console.log(`   Session created: ${session.id}`);
      console.log(`   Title: ${session.title}`);

      // Set as current session
      sessionManager.setCurrentSession(session.id);
      console.log('   Set as current session');

      // Add a test message
      console.log('3. Adding test message...');
      const testMessage = {
        id: `msg_${Date.now()}`,
        role: 'user' as const,
        content: 'This is a test message',
        timestamp: Date.now(),
      };
      await sessionManager.addMessage(testMessage);
      console.log('   Message added');

      // Retrieve messages
      console.log('4. Retrieving messages...');
      const messages = await sessionManager.getMessages(session.id);
      console.log(`   Retrieved ${messages.length} message(s)`);

      if (messages.length !== 1) {
        throw new Error(`Expected 1 message, got ${messages.length}`);
      }

      if (messages[0].content !== testMessage.content) {
        throw new Error('Message content mismatch');
      }

      // Save todos
      console.log('5. Saving todos...');
      const testTodos = [
        { content: 'Task 1', status: 'pending' as const, activeForm: 'Working on Task 1' },
        { content: 'Task 2', status: 'completed' as const, activeForm: 'Completing Task 2' },
      ];
      await sessionManager.saveTodos(testTodos);
      console.log('   Todos saved');

      // Retrieve todos
      console.log('6. Retrieving todos...');
      const todos = await sessionManager.getTodos(session.id);
      console.log(`   Retrieved ${todos.length} todo(s)`);

      if (todos.length !== 2) {
        throw new Error(`Expected 2 todos, got ${todos.length}`);
      }

      // List sessions
      console.log('7. Listing sessions...');
      const sessions = await sessionManager.listSessions();
      console.log(`   Found ${sessions.length} session(s)`);

      const foundSession = sessions.find(s => s.id === session.id);
      if (!foundSession) {
        throw new Error('Created session not found in list');
      }

      // Export session
      console.log('8. Exporting session...');
      const exported = await sessionManager.exportSession(session.id);
      if (!exported) {
        throw new Error('Failed to export session');
      }
      console.log(`   Exported session with ${exported.messages.length} message(s) and ${exported.todos.length} todo(s)`);

      // Get database stats
      console.log('9. Getting database stats...');
      const stats = db.getStats();
      console.log(`   Sessions: ${stats.sessionCount}`);
      console.log(`   Messages: ${stats.messageCount}`);
      console.log(`   Tool executions: ${stats.toolExecutionCount}`);

      // Delete session
      console.log('10. Deleting session...');
      await sessionManager.deleteSession(session.id);
      console.log('    Session deleted');

      // Verify deletion
      const deletedSession = await sessionManager.getSession(session.id);
      if (deletedSession) {
        throw new Error('Session should have been deleted');
      }
      console.log('    Deletion verified');

      // Close database
      db.close();

      console.log('\n========================================');
      console.log('Session Test PASSED');
      console.log('========================================\n');
    } catch (error) {
      console.error('\n========================================');
      console.error('Session Test FAILED');
      console.error('========================================');
      console.error('Error:', error instanceof Error ? error.message : error);
      throw error;
    }
  }
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config: Partial<TestConfig> = {};

  // Parse command line args
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--provider':
        config.provider = args[++i];
        break;
      case '--model':
        config.model = args[++i];
        break;
      case '--generation':
        config.generation = args[++i] as any;
        break;
      case '--message':
        config.testMessage = args[++i];
        break;
      case '--help':
        console.log(`
Usage: npx tsx scripts/headless-test.ts [options]

Options:
  --provider <name>     Model provider (deepseek, claude, openai, groq)
  --model <name>        Model name (e.g., deepseek-chat)
  --generation <gen>    Generation to test (gen1, gen2, gen3, gen4)
  --message <text>      Test message to send
  --help                Show this help

Environment:
  DEEPSEEK_API_KEY      API key for DeepSeek (or create .env file)
`);
        process.exit(0);
    }
  }

  const runner = new HeadlessTestRunner(config);
  await runner.initialize();
  await runner.runTest();
  await runner.runToolTest();
  await runner.runSessionTest();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
