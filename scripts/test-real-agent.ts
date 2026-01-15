/**
 * Real agent test - directly invokes AgentOrchestrator
 * This simulates what happens when user sends a message in the UI
 *
 * Environment variables:
 *   - TEST_GENERATION: gen1 | gen2 | gen3 | gen4 (default: gen1)
 *   - TEST_MESSAGE: Custom test message (optional)
 *   - AUTO_TEST: Set to enable auto-approve permissions
 */

import { config } from 'dotenv';
config();

// Set AUTO_TEST to auto-approve permissions
process.env.AUTO_TEST = 'true';

import { AgentOrchestrator } from '../src/main/agent/AgentOrchestrator';
import { GenerationManager } from '../src/main/generation/GenerationManager';
import { ConfigService } from '../src/main/services/ConfigService';
import type { AgentEvent, GenerationId } from '../src/shared/types';

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

if (!DEEPSEEK_API_KEY) {
  console.error('❌ DEEPSEEK_API_KEY not found');
  process.exit(1);
}

// Get generation from environment, default to gen1 for basic testing
const testGenId = (process.env.TEST_GENERATION || 'gen1') as GenerationId;

async function testRealAgent() {
  console.log('==========================================');
  console.log('  Real Agent Test');
  console.log('==========================================\n');

  // Initialize ConfigService
  const configService = new ConfigService();
  await configService.initialize();

  // Initialize GenerationManager
  const generationManager = new GenerationManager();

  // Switch to the requested generation
  const generation = generationManager.switchGeneration(testGenId);

  console.log(`📦 Using Generation: ${generation.name} (${generation.id})`);
  console.log(`   Tools: ${generation.tools.join(', ')}\n`);

  // Create orchestrator with correct interface
  const orchestrator = new AgentOrchestrator({
    generationManager,
    configService,
    onEvent: (event: AgentEvent) => {
      if (event.type === 'message') {
        const content = event.data.content || '';
        console.log(`[Event] message (${event.data.role}): ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);
      } else if (event.type === 'tool_call_start') {
        console.log(`[Event] tool_call_start: ${event.data.name}`);
      } else if (event.type === 'tool_call_end') {
        console.log(`[Event] tool_call_end: ${event.data.name} - ${event.data.result?.success ? 'success' : 'failed'}`);
      } else if (event.type === 'agent_complete') {
        console.log(`[Event] agent_complete`);
      } else if (event.type === 'error') {
        console.log(`[Event] error: ${event.data.message}`);
      } else {
        console.log(`[Event] ${event.type}`);
      }
    },
  });

  // Set working directory
  orchestrator.setWorkingDirectory(process.cwd());

  // Test message - simple for Gen1, more complex for Gen3+
  let testMessage = process.env.TEST_MESSAGE;

  if (!testMessage) {
    if (testGenId === 'gen1' || testGenId === 'gen2') {
      testMessage = '列出当前目录的文件';
    } else {
      testMessage = '列出当前目录的文件，然后读取 package.json 的内容';
    }
  }

  console.log(`Sending message: "${testMessage}"\n`);
  console.log('--- Agent Execution ---\n');

  try {
    await orchestrator.sendMessage(testMessage);
    console.log('\n--- Agent Completed ---');
    console.log('✅ Test passed! Agent executed successfully.');
    return true;
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    return false;
  }
}

testRealAgent()
  .then((success) => process.exit(success ? 0 : 1))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
