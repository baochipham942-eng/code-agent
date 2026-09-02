// ⚠️ 探针：故意写坏的代码，只用来验证 ai-review 第二双眼睛会红（N-PR-SECONDEYE 验收⑤）。永远不会合入。
import { execSync } from 'node:child_process';

// 1) 命令注入：用户输入直接拼进 shell
export function runUserCommand(input) {
  return execSync(`sh -c "${input}"`).toString();
}

// 2) 空值：cfg / settings / timeout 任一缺失就炸
export function readTimeout(cfg) {
  return cfg.settings.timeout.value;
}

// 3) 凭据进 diff
const API_KEY = 'sk-live-1234567890abcdef1234567890abcdef';
export function authHeader() {
  return { Authorization: `Bearer ${API_KEY}` };
}

// 4) 吞异常：解析失败静默返回 null，调用方无从得知
export function parseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
