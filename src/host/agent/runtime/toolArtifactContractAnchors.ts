import { existsSync, readFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import type { ToolCall } from '../../../shared/contract';
import { isSameArtifactRepairPath } from './artifactRepairGuard';
import type { RuntimeContext } from './runtimeContext';
import { getModifiedFilePath } from './toolArtifactRepairPolicy';

type ContractReplacementRegion = {
  start: number;
  end: number;
  oldText: string;
  diagnostics: string;
};

function findContractAssignmentRegion(content: string, contractName: string): ContractReplacementRegion | null {
  const assignmentPattern = new RegExp(`window\\.${contractName}\\s*=\\s*\\{`, 'g');
  const matches = [...content.matchAll(assignmentPattern)];
  if (matches.length === 0) return null;

  const start = matches[0].index ?? -1;
  if (start < 0) return null;

  let depth = 0;
  let sawOpenBrace = false;
  let inString: '"' | "'" | '`' | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = char;
      continue;
    }
    if (char === '{') {
      depth += 1;
      sawOpenBrace = true;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (sawOpenBrace && depth === 0) {
        let end = index + 1;
        while (/\s/.test(content[end] || '')) end += 1;
        if (content[end] === ';') end += 1;

        const duplicateTailStart = content.slice(end).search(/\n\s*(?:start|reset|snapshot|step|runSmokeTest)\s*\(/);
        if (duplicateTailStart >= 0) {
          const absoluteTailStart = end + duplicateTailStart;
          const scriptFooterStart = content.slice(absoluteTailStart).search(/\n\s*\/\/\s*Auto-run smoke test|\n\s*if\s*\(\s*typeof\s+window\s*!==\s*['"]undefined['"]\s*&&\s*window\.location\.search\.includes\(['"]autotest['"]\)/);
          if (scriptFooterStart > 0) {
            end = absoluteTailStart + scriptFooterStart;
          }
        }

        return {
          start,
          end,
          oldText: content.slice(start, end).trimEnd(),
          diagnostics: `expanded ${contractName} replacement from ${matches.length} assignment anchor(s)`,
        };
      }
    }
  }

  return null;
}

type ContractMethodRegion = {
  oldText: string;
  diagnostics: string;
};

function findContractMethodRegion(
  content: string,
  contractRegion: ContractReplacementRegion,
  methodName: string,
): ContractMethodRegion | null {
  const contractText = content.slice(contractRegion.start, contractRegion.end);
  const methodPattern = new RegExp(`(^|\\n)([ \\t]*)${methodName}\\s*\\(`, 'm');
  const match = methodPattern.exec(contractText);
  if (!match) return null;

  const localStart = match.index + (match[1] ? match[1].length : 0);
  const start = contractRegion.start + localStart;
  const braceStart = content.indexOf('{', start);
  if (braceStart < 0 || braceStart >= contractRegion.end) return null;

  let depth = 0;
  let sawOpenBrace = false;
  let inString: '"' | "'" | '`' | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = braceStart; index < contractRegion.end; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = char;
      continue;
    }
    if (char === '{') {
      depth += 1;
      sawOpenBrace = true;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (sawOpenBrace && depth === 0) {
        let end = index + 1;
        while (/\s/.test(content[end] || '')) end += 1;
        if (content[end] === ',') end += 1;

        return {
          oldText: content.slice(start, end).trimEnd(),
          diagnostics: `expanded ${methodName} replacement inside ${contractRegion.diagnostics}`,
        };
      }
    }
  }

  return null;
}

function detectContractMethodName(value: string): string | null {
  const methodNames = ['runSmokeTest', 'snapshot', 'step', 'reset', 'start'];
  const matches = methodNames.filter((methodName) => new RegExp(`\\b${methodName}\\s*\\(`).test(value));
  if (matches.length !== 1) return null;
  return matches[0];
}

function normalizePartialContractMethodReplacement(oldText: string, newText: string): string {
  let normalized = newText.trimEnd().replace(/\n\s*};\s*$/, '');
  const oldTextHasTrailingComma = /}\s*,\s*$/.test(oldText);
  if (oldTextHasTrailingComma && !/,\s*$/.test(normalized)) {
    normalized = `${normalized.trimEnd()},`;
  }
  return normalized;
}

export function maybeRepairArtifactContractEditAnchors(
  ctx: RuntimeContext,
  toolCall: ToolCall,
): ToolCall {
  const guard = ctx.artifact.repairGuard;
  if (!guard || (toolCall.name !== 'Edit' && toolCall.name !== 'edit_file')) return toolCall;

  const modifiedPath = getModifiedFilePath(toolCall);
  if (!modifiedPath || !isSameArtifactRepairPath(ctx, modifiedPath, guard.targetFile)) return toolCall;

  const edits = Array.isArray(toolCall.arguments?.edits) ? toolCall.arguments.edits : null;
  if (edits?.length !== 1) return toolCall;

  const edit = edits[0] as Record<string, unknown>;
  const oldText = typeof edit.old_text === 'string' ? edit.old_text : '';
  const newText = typeof edit.new_text === 'string' ? edit.new_text : '';
  const oldTextHasContractAssignment = /window\.__(?:GAME|INTERACTIVE)_TEST__\s*=/.test(oldText);
  const newTextHasContractAssignment = /window\.__(?:GAME|INTERACTIVE)_TEST__\s*=/.test(newText);
  const newTextClosesContract = /\n\s*};\s*$/.test(newText.trimEnd());
  const looksLikePartialContractRewrite =
    !oldTextHasContractAssignment &&
    newTextClosesContract &&
    /\b(?:start|reset|snapshot|step|runSmokeTest)\s*\(/.test(`${oldText}\n${newText}`);

  if (!newText || (!newTextHasContractAssignment && !looksLikePartialContractRewrite)) return toolCall;
  if (oldText && /window\.__(?:GAME|INTERACTIVE)_TEST__\s*=/.test(oldText) && oldText.length > 4_000) {
    return toolCall;
  }

  const absolutePath = isAbsolute(modifiedPath)
    ? modifiedPath
    : resolve(ctx.workingDirectory || process.cwd(), modifiedPath);
  if (!existsSync(absolutePath)) return toolCall;

  let content: string;
  try {
    content = readFileSync(absolutePath, 'utf-8');
  } catch {
    return toolCall;
  }

  const contractName = /window\.__INTERACTIVE_TEST__\s*=/.test(`${newText}\n${oldText}`)
    ? '__INTERACTIVE_TEST__'
    : '__GAME_TEST__';
  const region = findContractAssignmentRegion(content, contractName);
  if (!region) return toolCall;

  if (looksLikePartialContractRewrite) {
    const methodName = detectContractMethodName(`${oldText}\n${newText}`);
    if (methodName) {
      const methodRegion = findContractMethodRegion(content, region, methodName);
      if (methodRegion) {
        return {
          ...toolCall,
          arguments: {
            ...toolCall.arguments,
            edits: [{
              ...edit,
              old_text: methodRegion.oldText,
              new_text: normalizePartialContractMethodReplacement(methodRegion.oldText, newText),
            }],
            _artifactRepairAnchorExpanded: true,
            _artifactRepairAnchorExpandedReason: methodRegion.diagnostics,
          },
        };
      }
    }
  }

  return {
    ...toolCall,
    arguments: {
      ...toolCall.arguments,
      edits: [{
        ...edit,
        old_text: region.oldText,
      }],
      _artifactRepairAnchorExpanded: true,
      _artifactRepairAnchorExpandedReason: region.diagnostics,
    },
  };
}
