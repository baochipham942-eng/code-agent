// ============================================================================
// Run Command - 单次执行模式
// ============================================================================

import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import { createCLIAgent } from '../adapter';
import { terminalOutput, jsonOutput } from '../output';
import { cleanup, initializeCLIServices, getDatabaseService } from '../bootstrap';
import type { CLIGlobalOptions } from '../types';
import { extractJSON } from '../utils/jsonExtractor';
import { validateSchema, formatValidationErrors, type JSONSchema } from '../utils/schemaValidator';

/**
 * Read stdin when piped (non-TTY)
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

/**
 * 解析 output schema：支持 JSON 字符串或文件路径
 */
function resolveOutputSchema(
  schemaStr?: string,
  schemaFile?: string
): JSONSchema | null {
  if (schemaFile) {
    const resolved = path.resolve(schemaFile);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Schema 文件不存在: ${resolved}`);
    }
    const content = fs.readFileSync(resolved, 'utf-8');
    try {
      return JSON.parse(content) as JSONSchema;
    } catch {
      throw new Error(`Schema 文件不是有效的 JSON: ${resolved}`);
    }
  }

  if (schemaStr) {
    try {
      return JSON.parse(schemaStr) as JSONSchema;
    } catch {
      throw new Error(`--output-schema 不是有效的 JSON 字符串`);
    }
  }

  return null;
}

export const runCommand = new Command('run')
  .description('执行单次任务')
  .argument('<prompt>', '要执行的任务描述')
  .option('-s, --session <id>', '恢复指定会话')
  .option('--output-schema <json>', '用 JSON Schema 验证输出结构')
  .option('--output-schema-file <path>', '从文件读取 JSON Schema')
  .option('--max-retries <n>', '结构化输出验证失败时的最大重试次数', '3')
  .action(async (prompt: string, options: {
    session?: string;
    outputSchema?: string;
    outputSchemaFile?: string;
    maxRetries?: string;
  }, command: Command) => {
    const globalOpts = command.parent?.opts() as CLIGlobalOptions;
    const isJson = globalOpts?.json || globalOpts?.outputFormat === 'json' || globalOpts?.outputFormat === 'stream-json';

    // Read stdin and prepend to prompt if available
    const stdinContent = await readStdin();
    let fullPrompt = prompt;
    if (stdinContent) {
      fullPrompt = `${stdinContent}\n\n${prompt}`;
    }

    // 检测空 prompt，优雅处理
    if (!fullPrompt?.trim()) {
      if (isJson) {
        console.log(JSON.stringify({ success: true, output: '请提供任务描述' }));
      } else {
        console.log('请提供任务描述');
      }
      process.exit(0);
    }

    // 解析 output schema
    let outputSchema: JSONSchema | null = null;
    try {
      outputSchema = resolveOutputSchema(options.outputSchema, options.outputSchemaFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isJson) {
        jsonOutput.error(message);
      } else {
        terminalOutput.error(message);
      }
      process.exit(1);
    }

    const maxRetries = parseInt(options.maxRetries || '3', 10);

    try {
      // 初始化服务
      await initializeCLIServices();

      // 显示数据库状态
      const db = getDatabaseService();
      if (!isJson && db) {
        const stats = db.getStats();
        if (globalOpts?.debug) {
          terminalOutput.info(`数据库: ${stats.sessionCount} 会话, ${stats.messageCount} 消息`);
        }
      }

      if (!isJson) {
        terminalOutput.info(`项目目录: ${globalOpts?.project || process.cwd()}`);
        terminalOutput.info(`代际: ${globalOpts?.gen || 'gen8'}`);
        if (outputSchema) {
          terminalOutput.info(`结构化输出: 已启用 (最多重试 ${maxRetries} 次)`);
        }
        terminalOutput.startThinking('初始化中...');
      } else {
        jsonOutput.start();
      }

      // 创建 Agent 并运行
      const agent = await createCLIAgent({
        project: globalOpts?.project,
        gen: globalOpts?.gen,
        model: globalOpts?.model,
        provider: globalOpts?.provider,
        json: globalOpts?.json,
        debug: globalOpts?.debug,
        outputFormat: globalOpts?.outputFormat,
        systemPrompt: globalOpts?.systemPrompt,
        metrics: globalOpts?.metrics,
      });

      // 恢复会话（如果指定）
      if (options.session) {
        const restored = await agent.restoreSession(options.session);
        if (!isJson) {
          if (restored) {
            terminalOutput.info(`已恢复会话: ${options.session}`);
          } else {
            terminalOutput.warning(`无法恢复会话: ${options.session}，创建新会话`);
          }
        }
      }

      // 如果启用了 schema 验证，在 prompt 中附加 schema 要求
      let currentPrompt = fullPrompt;
      if (outputSchema) {
        currentPrompt = `${fullPrompt}\n\n请严格按照以下 JSON Schema 输出 JSON：\n${JSON.stringify(outputSchema, null, 2)}`;
      }

      let result = await agent.run(currentPrompt);
      let retryCount = 0;

      // 结构化输出验证与重试循环
      if (outputSchema && result.success && result.output) {
        while (retryCount < maxRetries) {
          const extracted = extractJSON(result.output || '');

          if (extracted === null) {
            retryCount++;
            if (retryCount >= maxRetries) {
              if (!isJson) {
                terminalOutput.error(
                  `结构化输出验证失败: 无法从响应中提取 JSON（已重试 ${maxRetries} 次）`
                );
              }
              break;
            }

            if (!isJson) {
              terminalOutput.warning(
                `结构化输出: 无法提取 JSON，重试中 (${retryCount}/${maxRetries})...`
              );
            }

            const retryPrompt =
              `\n\n[SYSTEM] 上一次输出不符合要求的 JSON Schema。验证错误：无法从响应中提取有效的 JSON。请严格按照以下 Schema 输出 JSON：${JSON.stringify(outputSchema)}`;
            result = await agent.run(retryPrompt);
            continue;
          }

          const validation = validateSchema(extracted, outputSchema);

          if (validation.valid) {
            // 验证通过
            if (globalOpts?.outputFormat === 'json' || globalOpts?.json) {
              // JSON 模式：只输出提取的结构化数据
              console.log(JSON.stringify(extracted, null, 2));
            } else if (!isJson) {
              terminalOutput.success('结构化输出验证通过 ✓');
            }
            // 将验证过的 JSON 附加到 result
            (result as any).structuredOutput = extracted;
            break;
          }

          // 验证失败
          retryCount++;
          if (retryCount >= maxRetries) {
            const errorMsg = formatValidationErrors(validation.errors);
            if (!isJson) {
              terminalOutput.error(
                `结构化输出验证失败（已重试 ${maxRetries} 次）:\n${errorMsg}`
              );
            }
            break;
          }

          if (!isJson) {
            terminalOutput.warning(
              `结构化输出验证失败，重试中 (${retryCount}/${maxRetries})...`
            );
          }

          const errorDetails = formatValidationErrors(validation.errors);
          const retryPrompt =
            `\n\n[SYSTEM] 上一次输出不符合要求的 JSON Schema。验证错误：\n${errorDetails}\n请严格按照以下 Schema 输出 JSON：${JSON.stringify(outputSchema)}`;
          result = await agent.run(retryPrompt);
        }
      }

      // 显示会话 ID
      if (!isJson && agent.getSessionId()) {
        terminalOutput.info(`会话 ID: ${agent.getSessionId()}`);
      }

      // 输出最终结果（JSON 模式，无 schema 验证时）
      if (isJson && !outputSchema) {
        jsonOutput.result(result);
      } else if (isJson && outputSchema) {
        // schema 模式下 JSON 输出：包含结构化数据和验证状态
        const extracted = extractJSON(result.output || '');
        const validation = extracted ? validateSchema(extracted, outputSchema) : null;
        jsonOutput.result({
          ...result,
          structuredOutput: extracted,
          schemaValid: validation?.valid ?? false,
          schemaErrors: validation?.valid === false ? validation.errors : undefined,
        } as any);
      }

      // 设置退出码并退出
      await cleanup();
      process.exit(result.success ? 0 : 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (isJson) {
        jsonOutput.error(message);
      } else {
        terminalOutput.error(message);
      }

      await cleanup();
      process.exit(1);
    }
  });
