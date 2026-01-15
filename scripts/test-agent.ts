#!/usr/bin/env npx ts-node
/**
 * Test script to verify agent functionality without GUI
 * Run: npx ts-node scripts/test-agent.ts
 */

import { ModelRouter } from '../src/main/model/ModelRouter';

// Test 1: Verify embedded tool call parsing
function testEmbeddedToolCallParsing() {
  console.log('\n=== Test 1: Embedded Tool Call Parsing ===');

  const router = new ModelRouter();

  // Simulate DeepSeek response with embedded tool call
  const mockResponse = {
    choices: [{
      message: {
        role: 'assistant',
        content: '我看到这是一个Electron + React + TypeScript项目。让我先查看一下目录结构。\n\nCalling list_directory({"path":"src", "recursive":true})'
      }
    }]
  };

  // Access private method through prototype
  const parseMethod = (router as any).parseOpenAIResponse.bind(router);
  const result = parseMethod(mockResponse);

  if (result.type === 'tool_use' && result.toolCalls?.[0]?.name === 'list_directory') {
    console.log('✅ PASS: Embedded tool call parsed correctly');
    console.log('   Tool:', result.toolCalls[0].name);
    console.log('   Args:', JSON.stringify(result.toolCalls[0].arguments));
    return true;
  } else {
    console.log('❌ FAIL: Embedded tool call not parsed');
    console.log('   Got:', result.type);
    return false;
  }
}

// Test 2: Verify standard tool call parsing still works
function testStandardToolCallParsing() {
  console.log('\n=== Test 2: Standard Tool Call Parsing ===');

  const router = new ModelRouter();

  // Simulate DeepSeek response with proper tool_calls
  const mockResponse = {
    choices: [{
      message: {
        role: 'assistant',
        content: '让我创建任务列表',
        tool_calls: [{
          id: 'call_123',
          type: 'function',
          function: {
            name: 'todo_write',
            arguments: '{"todos":[{"content":"test","status":"pending","activeForm":"testing"}]}'
          }
        }]
      }
    }]
  };

  const parseMethod = (router as any).parseOpenAIResponse.bind(router);
  const result = parseMethod(mockResponse);

  if (result.type === 'tool_use' && result.toolCalls?.[0]?.name === 'todo_write') {
    console.log('✅ PASS: Standard tool call parsed correctly');
    console.log('   Tool:', result.toolCalls[0].name);
    return true;
  } else {
    console.log('❌ FAIL: Standard tool call not parsed');
    return false;
  }
}

// Test 3: Verify text response still works
function testTextResponse() {
  console.log('\n=== Test 3: Plain Text Response ===');

  const router = new ModelRouter();

  const mockResponse = {
    choices: [{
      message: {
        role: 'assistant',
        content: '这是一个普通的文本回复，没有工具调用。'
      }
    }]
  };

  const parseMethod = (router as any).parseOpenAIResponse.bind(router);
  const result = parseMethod(mockResponse);

  if (result.type === 'text' && result.content === '这是一个普通的文本回复，没有工具调用。') {
    console.log('✅ PASS: Plain text response handled correctly');
    return true;
  } else {
    console.log('❌ FAIL: Plain text response not handled correctly');
    console.log('   Got type:', result.type);
    return false;
  }
}

// Test 4: Edge case - malformed embedded tool call
function testMalformedEmbeddedToolCall() {
  console.log('\n=== Test 4: Malformed Embedded Tool Call (should fall back to text) ===');

  const router = new ModelRouter();

  const mockResponse = {
    choices: [{
      message: {
        role: 'assistant',
        content: '让我调用工具 Calling some_tool(this is not valid json)'
      }
    }]
  };

  const parseMethod = (router as any).parseOpenAIResponse.bind(router);
  const result = parseMethod(mockResponse);

  if (result.type === 'text') {
    console.log('✅ PASS: Malformed tool call fell back to text');
    return true;
  } else {
    console.log('❌ FAIL: Malformed tool call should fall back to text');
    return false;
  }
}

// Run all tests
async function main() {
  console.log('========================================');
  console.log('  Code Agent - Unit Tests');
  console.log('========================================');

  const results = [
    testEmbeddedToolCallParsing(),
    testStandardToolCallParsing(),
    testTextResponse(),
    testMalformedEmbeddedToolCall(),
  ];

  const passed = results.filter(r => r).length;
  const total = results.length;

  console.log('\n========================================');
  console.log(`  Results: ${passed}/${total} tests passed`);
  console.log('========================================');

  process.exit(passed === total ? 0 : 1);
}

main().catch(console.error);
