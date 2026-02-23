// ============================================================================
// Worker Sandbox - Isolated child_process for PTC code execution
// ============================================================================
// CommonJS format (fork target). Receives code + allowedTools via IPC,
// exposes callTool() global, captures console output, returns result.
// ============================================================================

'use strict';

const MAX_TOOL_CALLS = 50;
const MAX_OUTPUT_SIZE = 32 * 1024; // 32KB

let callCount = 0;
const pendingCalls = new Map();
const consoleOutput = [];

// Hijack console to capture output
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

function capture(level, args) {
  const line = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  consoleOutput.push(`[${level}] ${line}`);
}

console.log = (...args) => capture('log', args);
console.warn = (...args) => capture('warn', args);
console.error = (...args) => capture('error', args);

// Handle IPC messages from parent
process.on('message', async (msg) => {
  if (msg.type === 'execute') {
    await executeCode(msg.code, msg.allowedTools);
  } else if (msg.type === 'tool_result') {
    const handler = pendingCalls.get(msg.id);
    if (handler) {
      pendingCalls.delete(msg.id);
      handler(msg.result);
    }
  }
});

/**
 * callTool - 全局异步函数，worker 代码通过它调用主进程工具
 */
function createCallTool(allowedTools) {
  return async function callTool(name, args) {
    if (!allowedTools.includes(name)) {
      throw new Error(`Tool "${name}" not in allowed list: [${allowedTools.join(', ')}]`);
    }

    callCount++;
    if (callCount > MAX_TOOL_CALLS) {
      throw new Error(`Max tool calls exceeded (${MAX_TOOL_CALLS})`);
    }

    return new Promise((resolve, reject) => {
      const id = `call_${callCount}`;
      const timeout = setTimeout(() => {
        pendingCalls.delete(id);
        reject(new Error(`Tool call "${name}" timed out after 30s`));
      }, 30000);

      pendingCalls.set(id, (result) => {
        clearTimeout(timeout);
        if (result.success) {
          resolve(result);
        } else {
          reject(new Error(result.error || `Tool "${name}" failed`));
        }
      });

      process.send({ type: 'tool_call', id, name, args: args || {} });
    });
  };
}

async function executeCode(code, allowedTools) {
  try {
    // Inject callTool into global scope
    globalThis.callTool = createCallTool(allowedTools || []);

    // Wrap code in async IIFE
    const wrappedCode = `(async () => { ${code} })()`;
    const asyncFn = new Function('callTool', `return ${wrappedCode}`);
    const result = await asyncFn(globalThis.callTool);

    // Build output
    const stdout = consoleOutput.join('\n');
    let output = '';

    if (stdout) {
      output += stdout;
    }

    if (result !== undefined && result !== null) {
      const resultStr = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
      if (output) output += '\n\n--- Return Value ---\n';
      output += resultStr;
    }

    // Truncate if too large
    if (output.length > MAX_OUTPUT_SIZE) {
      output = output.substring(0, MAX_OUTPUT_SIZE) + '\n\n[Output truncated at 32KB]';
    }

    if (!output) {
      output = '(no output)';
    }

    process.send({ type: 'done', success: true, output, toolCallCount: callCount });
  } catch (err) {
    const stdout = consoleOutput.join('\n');
    let output = '';
    if (stdout) output = stdout + '\n\n';
    output += `Error: ${err.message || String(err)}`;

    if (output.length > MAX_OUTPUT_SIZE) {
      output = output.substring(0, MAX_OUTPUT_SIZE) + '\n\n[Output truncated at 32KB]';
    }

    process.send({ type: 'done', success: false, output, toolCallCount: callCount });
  }
}

// Graceful exit if parent disconnects
process.on('disconnect', () => {
  process.exit(0);
});
