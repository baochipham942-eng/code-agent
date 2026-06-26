import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ComputerSurfaceAxQuality } from '../../../shared/contract/desktop';
import type { ComputerSurfaceAction, ComputerSurfaceActionResult } from './computerSurface';

const execFileAsync = promisify(execFile);

export type BackgroundAxFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
  coordSpace: 'screen';
};

export type BackgroundAxElement = {
  index: number;
  role: string;
  name: string;
  axPath: string;
  frame?: BackgroundAxFrame | null;
};

export class BackgroundAxBridge {
  async executeAction(action: ComputerSurfaceAction): Promise<ComputerSurfaceActionResult> {
    const elementName = action.name || action.selector || '';
    const role = normalizeBackgroundRole(action.role);
    const axPath = action.axPath || '';
    const scriptArgs = [
      action.targetApp || '',
      normalizeBackgroundAction(action.action),
      role,
      elementName,
      action.text || '',
      action.exact ? 'true' : 'false',
      axPath,
    ];

    try {
      const stdout = getExecStdout(await execFileAsync('osascript', [
        ...toAppleScriptArgs(BACKGROUND_AX_ACTION_SCRIPT),
        ...scriptArgs,
      ], {
        timeout: Math.max(1_000, Math.min(action.timeout || 8_000, 30_000)),
        maxBuffer: 1024 * 1024,
      }));
      const parsed = parseBackgroundActionOutput(stdout, action.action, action.targetApp || '');
      const output = parsed.output || `Background action completed: ${action.action}`;
      return {
        success: true,
        output: action.action === 'type'
          ? `${output} text: ${action.text?.length || 0} chars`
          : output,
        metadata: {
          backgroundSurface: true,
          targetApp: action.targetApp,
          targetRole: role || null,
          targetName: elementName || null,
          targetAxPath: axPath || null,
          targetAxFrame: parsed.frame,
          pointerTarget: parsed.frame
            ? {
                label: elementName || role || axPath || action.targetApp || null,
                boundingBox: parsed.frame,
                coordSpace: parsed.frame.coordSpace,
              }
            : undefined,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Background action failed: ${formatExecError(error)}`,
      };
    }
  }

  async listElements(action: ComputerSurfaceAction): Promise<ComputerSurfaceActionResult> {
    const targetApp = action.targetApp || '';
    const limit = clampInt(action.limit, 1, 80, 40);
    const maxDepth = clampInt(action.maxDepth, 1, 8, 4);

    try {
      const stdout = getExecStdout(await execFileAsync('osascript', [
        ...toAppleScriptArgs(BACKGROUND_AX_ELEMENTS_SCRIPT),
        targetApp,
        String(limit),
        String(maxDepth),
      ], {
        timeout: Math.max(1_000, Math.min(action.timeout || 8_000, 30_000)),
        maxBuffer: 1024 * 1024,
      }));
      const elements = parseBackgroundElementLines(stdout);
      const axQuality = assessAxTreeQuality(elements, elements.length >= limit);
      const poorAxTree = axQuality.grade === 'poor';
      const blockingReasons = poorAxTree
        ? [`AX tree quality is poor for ${targetApp}: ${axQuality.reasons.join('; ')}`]
        : undefined;
      const recommendedAction = poorAxTree
        ? 'Try a narrower target window, increase maxDepth, or use foreground observe before retrying the action.'
        : null;
      const output = elements.length > 0
        ? [
            `Found ${elements.length} background AX elements for ${targetApp}:`,
            ...elements.map((element) => [
              `${element.index}. ${element.role}${element.name ? ` "${element.name}"` : ''}`,
              element.axPath ? ` [axPath=${element.axPath}]` : '',
              element.frame ? ` [frame=${formatAxFrame(element.frame)}]` : '',
            ].join('')),
            formatAxQualityLine(axQuality),
          ].join('\n')
        : [
            `No background AX elements found for ${targetApp}.`,
            formatAxQualityLine(axQuality),
          ].join('\n');
      return {
        success: true,
        output,
        metadata: {
          backgroundSurface: true,
          targetApp,
          elements,
          targetElementCount: elements.length,
          limit,
          maxDepth,
          axQuality,
          failureKind: poorAxTree ? 'ax_tree_poor' : null,
          blockingReasons,
          recommendedAction,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Background element listing failed: ${formatExecError(error)}`,
      };
    }
  }

  locateElementFromList(
    action: ComputerSurfaceAction,
    listResult: ComputerSurfaceActionResult,
  ): ComputerSurfaceActionResult {
    if (!listResult.success) {
      return listResult;
    }

    const targetApp = action.targetApp || '';
    const elements = (listResult.metadata?.elements as BackgroundAxElement[] | undefined) || [];
    const wantedRole = normalizeBackgroundRole(action.role);
    const wantedName = action.name?.trim() || '';
    const exact = action.exact === true;

    const matches = elements.filter((element) => {
      if (wantedRole && normalizeBackgroundRole(element.role) !== wantedRole) {
        return false;
      }
      if (!wantedName) {
        return true;
      }
      const elementName = element.name || '';
      if (exact) {
        return elementName === wantedName;
      }
      return elementName.toLowerCase().includes(wantedName.toLowerCase());
    });

    if (matches.length === 0) {
      return {
        success: false,
        error: `Target element not found for ${targetApp}: role="${action.role}"${wantedName ? ` name="${wantedName}"` : ''}`,
        metadata: {
          backgroundSurface: true,
          targetApp,
          targetRole: wantedRole || null,
          targetName: wantedName || null,
          failureKind: 'locator_missing',
          recommendedAction: 'Run get_ax_elements for the target app to inspect available roles and names.',
        },
      };
    }

    const chosen = matches[0];
    const ambiguous = matches.length > 1;
    const descriptor = `role="${chosen.role}"${chosen.name ? ` name="${chosen.name}"` : ''}`;
    const output = ambiguous
      ? `Located ${matches.length} matches for ${targetApp}; using first: ${descriptor} [axPath=${chosen.axPath}]`
      : `Located ${descriptor} for ${targetApp} [axPath=${chosen.axPath}]`;

    return {
      success: true,
      output,
      metadata: {
        backgroundSurface: true,
        targetApp,
        targetRole: chosen.role,
        targetName: chosen.name || null,
        targetAxPath: chosen.axPath,
        targetAxFrame: chosen.frame || null,
        axPath: chosen.axPath,
        pointerTarget: chosen.frame
          ? {
              label: chosen.name || chosen.role || chosen.axPath,
              boundingBox: chosen.frame,
              coordSpace: chosen.frame.coordSpace,
            }
          : undefined,
        matchCount: matches.length,
        matches,
        failureKind: ambiguous ? 'locator_ambiguous' : null,
        recommendedAction: ambiguous
          ? 'Multiple elements matched; pass a more specific name or pick an axPath from get_ax_elements.'
          : null,
      },
    };
  }
}

const BACKGROUND_AX_ACTION_SCRIPT = [
  'on run argv',
  'set targetApp to item 1 of argv',
  'set actionName to item 2 of argv',
  'set targetRole to item 3 of argv',
  'set targetName to item 4 of argv',
  'set inputText to item 5 of argv',
  'set exactMatch to item 6 of argv',
  'set targetAxPath to item 7 of argv',
  'tell application "System Events"',
  'if not (exists application process targetApp) then error "Target app is not running: " & targetApp',
  'tell application process targetApp',
  'if exists window 1 then',
  'set rootElement to window 1',
  'else',
  'set rootElement to it',
  'end if',
  'if targetAxPath is not "" then',
  'set targetElement to my elementAtPath(rootElement, targetAxPath)',
  'else',
  'set targetElement to my findElement(rootElement, targetRole, targetName, exactMatch)',
  'end if',
  'if targetElement is missing value then error "Target element not found"',
  'set targetFrame to my safeFrame(targetElement)',
  'if actionName is "type" then',
  'my setElementValue(targetElement, inputText)',
  'return "Background type completed: " & targetApp & linefeed & "AXFRAME" & tab & targetFrame',
  'else',
  'perform action "AXPress" of targetElement',
  'if actionName is "doubleClick" then perform action "AXPress" of targetElement',
  'return "Background " & actionName & " completed: " & targetApp & linefeed & "AXFRAME" & tab & targetFrame',
  'end if',
  'end tell',
  'end tell',
  'end run',
  'on findElement(theElement, targetRole, targetName, exactMatch)',
  'tell application "System Events"',
  'set elementRole to my safeRole(theElement)',
  'set elementLabel to my safeLabel(theElement)',
  'if my roleMatches(elementRole, targetRole) and my labelMatches(elementLabel, targetName, exactMatch) then return theElement',
  'try',
  'repeat with childElement in UI elements of theElement',
  'set foundChild to my findElement(childElement, targetRole, targetName, exactMatch)',
  'if foundChild is not missing value then return foundChild',
  'end repeat',
  'end try',
  'end tell',
  'return missing value',
  'end findElement',
  'on elementAtPath(rootElement, targetAxPath)',
  'tell application "System Events"',
  'set currentElement to rootElement',
  'set pathItems to my splitText(targetAxPath, ".")',
  'repeat with pathItem in pathItems',
  'try',
  'set pathIndex to (contents of pathItem) as integer',
  'if pathIndex is less than 1 then return missing value',
  'set childElements to UI elements of currentElement',
  'if pathIndex is greater than (count of childElements) then return missing value',
  'set currentElement to item pathIndex of childElements',
  'on error',
  'return missing value',
  'end try',
  'end repeat',
  'return currentElement',
  'end tell',
  'end elementAtPath',
  'on splitText(sourceText, delimiterText)',
  'set oldDelimiters to AppleScript\'s text item delimiters',
  'set AppleScript\'s text item delimiters to delimiterText',
  'set textItems to text items of sourceText',
  'set AppleScript\'s text item delimiters to oldDelimiters',
  'return textItems',
  'end splitText',
  'on safeRole(theElement)',
  'tell application "System Events"',
  'try',
  'return role of theElement as text',
  'on error',
  'return ""',
  'end try',
  'end tell',
  'end safeRole',
  'on safeLabel(theElement)',
  'tell application "System Events"',
  'set labels to ""',
  'try',
  'set labelPart to name of theElement',
  'if labelPart is not missing value then set labels to labels & " " & (labelPart as text)',
  'end try',
  'try',
  'set labelPart to description of theElement',
  'if labelPart is not missing value then set labels to labels & " " & (labelPart as text)',
  'end try',
  'try',
  'set labelPart to value of attribute "AXTitle" of theElement',
  'if labelPart is not missing value then set labels to labels & " " & (labelPart as text)',
  'end try',
  'try',
  'set labelPart to value of attribute "AXDescription" of theElement',
  'if labelPart is not missing value then set labels to labels & " " & (labelPart as text)',
  'end try',
  'return labels',
  'end tell',
  'end safeLabel',
  'on safeFrame(theElement)',
  'tell application "System Events"',
  'try',
  'set elementPosition to position of theElement',
  'set elementSize to size of theElement',
  'return (item 1 of elementPosition as text) & "," & (item 2 of elementPosition as text) & "," & (item 1 of elementSize as text) & "," & (item 2 of elementSize as text)',
  'on error',
  'return ""',
  'end try',
  'end tell',
  'end safeFrame',
  'on roleMatches(elementRole, targetRole)',
  'if targetRole is "" then return true',
  'if elementRole is targetRole then return true',
  'if targetRole is "button" and elementRole contains "Button" then return true',
  'if targetRole is "textbox" and (elementRole contains "TextField" or elementRole contains "TextArea" or elementRole contains "text") then return true',
  'if targetRole is "checkbox" and elementRole contains "CheckBox" then return true',
  'if targetRole is "radio" and elementRole contains "RadioButton" then return true',
  'if targetRole is "combobox" and elementRole contains "ComboBox" then return true',
  'if targetRole is "menuitem" and elementRole contains "MenuItem" then return true',
  'if targetRole is "tab" and elementRole contains "Tab" then return true',
  'if targetRole is "link" and elementRole contains "Link" then return true',
  'return elementRole contains targetRole',
  'end roleMatches',
  'on labelMatches(elementLabel, targetName, exactMatch)',
  'if targetName is "" then return true',
  'if exactMatch is "true" then return elementLabel is targetName',
  'return elementLabel contains targetName',
  'end labelMatches',
  'on setElementValue(theElement, inputText)',
  'tell application "System Events"',
  'try',
  'set value of theElement to inputText',
  'return',
  'end try',
  'try',
  'set value of attribute "AXValue" of theElement to inputText',
  'return',
  'end try',
  'error "Target element does not accept AXValue"',
  'end tell',
  'end setElementValue',
];

const BACKGROUND_AX_ELEMENTS_SCRIPT = [
  'property outputLines : {}',
  'property itemCount : 0',
  'property maxItems : 40',
  'property maxDepthLimit : 4',
  'on run argv',
  'set outputLines to {}',
  'set itemCount to 0',
  'set targetApp to item 1 of argv',
  'set maxItems to item 2 of argv as integer',
  'set maxDepthLimit to item 3 of argv as integer',
  'tell application "System Events"',
  'if not (exists application process targetApp) then error "Target app is not running: " & targetApp',
  'tell application process targetApp',
  'if exists window 1 then',
  'set rootElement to window 1',
  'else',
  'set rootElement to it',
  'end if',
  'my collectElements(rootElement, 0, "")',
  'end tell',
  'end tell',
  'set oldDelimiters to AppleScript\'s text item delimiters',
  'set AppleScript\'s text item delimiters to linefeed',
  'set resultText to outputLines as text',
  'set AppleScript\'s text item delimiters to oldDelimiters',
  'return resultText',
  'end run',
  'on collectElements(theElement, currentDepth, currentPath)',
  'if itemCount is greater than or equal to maxItems then return',
  'tell application "System Events"',
  'set elementRole to my safeRole(theElement)',
  'set elementLabel to my compactLabel(my safeLabel(theElement))',
  'if my isInterestingRole(elementRole) and elementLabel is not "" then',
  'set itemCount to itemCount + 1',
  'set elementFrame to my safeFrame(theElement)',
  'set end of outputLines to (itemCount as text) & tab & elementRole & tab & elementLabel & tab & currentPath & tab & elementFrame',
  'end if',
  'if currentDepth is greater than or equal to maxDepthLimit then return',
  'try',
  'set childIndex to 0',
  'repeat with childElement in UI elements of theElement',
  'set childIndex to childIndex + 1',
  'if currentPath is "" then',
  'set childPath to childIndex as text',
  'else',
  'set childPath to currentPath & "." & (childIndex as text)',
  'end if',
  'my collectElements(childElement, currentDepth + 1, childPath)',
  'if itemCount is greater than or equal to maxItems then exit repeat',
  'end repeat',
  'end try',
  'end tell',
  'end collectElements',
  'on isInterestingRole(elementRole)',
  'if elementRole contains "Button" then return true',
  'if elementRole contains "CheckBox" then return true',
  'if elementRole contains "RadioButton" then return true',
  'if elementRole contains "TextField" then return true',
  'if elementRole contains "TextArea" then return true',
  'if elementRole contains "ComboBox" then return true',
  'if elementRole contains "PopUpButton" then return true',
  'if elementRole contains "MenuButton" then return true',
  'if elementRole contains "MenuItem" then return true',
  'if elementRole contains "Tab" then return true',
  'if elementRole contains "Link" then return true',
  'return false',
  'end isInterestingRole',
  'on safeRole(theElement)',
  'tell application "System Events"',
  'try',
  'return role of theElement as text',
  'on error',
  'return ""',
  'end try',
  'end tell',
  'end safeRole',
  'on safeLabel(theElement)',
  'tell application "System Events"',
  'set labels to ""',
  'try',
  'set labelPart to name of theElement',
  'if labelPart is not missing value then set labels to labels & " " & (labelPart as text)',
  'end try',
  'try',
  'set labelPart to description of theElement',
  'if labelPart is not missing value then set labels to labels & " " & (labelPart as text)',
  'end try',
  'try',
  'set labelPart to value of attribute "AXTitle" of theElement',
  'if labelPart is not missing value then set labels to labels & " " & (labelPart as text)',
  'end try',
  'try',
  'set labelPart to value of attribute "AXDescription" of theElement',
  'if labelPart is not missing value then set labels to labels & " " & (labelPart as text)',
  'end try',
  'return labels',
  'end tell',
  'end safeLabel',
  'on safeFrame(theElement)',
  'tell application "System Events"',
  'try',
  'set elementPosition to position of theElement',
  'set elementSize to size of theElement',
  'return (item 1 of elementPosition as text) & "," & (item 2 of elementPosition as text) & "," & (item 1 of elementSize as text) & "," & (item 2 of elementSize as text)',
  'on error',
  'return ""',
  'end try',
  'end tell',
  'end safeFrame',
  'on compactLabel(rawLabel)',
  'set cleaned to my replaceText(rawLabel, tab, " ")',
  'set cleaned to my replaceText(cleaned, linefeed, " ")',
  'set cleaned to my replaceText(cleaned, return, " ")',
  'repeat while cleaned contains "  "',
  'set cleaned to my replaceText(cleaned, "  ", " ")',
  'end repeat',
  'if length of cleaned is greater than 80 then set cleaned to text 1 thru 80 of cleaned',
  'return cleaned',
  'end compactLabel',
  'on replaceText(sourceText, searchText, replacementText)',
  'set oldDelimiters to AppleScript\'s text item delimiters',
  'set AppleScript\'s text item delimiters to searchText',
  'set textItems to text items of sourceText',
  'set AppleScript\'s text item delimiters to replacementText',
  'set replacedText to textItems as text',
  'set AppleScript\'s text item delimiters to oldDelimiters',
  'return replacedText',
  'end replaceText',
];

function normalizeBackgroundAction(action: string): string {
  return action === 'doubleClick' ? 'doubleClick' : action;
}

function normalizeBackgroundRole(role: string | undefined): string {
  if (!role) return '';
  const compactRole = role.trim().replace(/^AX/i, '').toLowerCase();
  if (compactRole === 'textfield' || compactRole === 'textarea' || compactRole === 'text') return 'textbox';
  if (compactRole === 'checkbox') return 'checkbox';
  if (compactRole === 'radiobutton') return 'radio';
  if (compactRole === 'combobox') return 'combobox';
  if (compactRole === 'popupbutton' || compactRole === 'menubutton') return 'button';
  if (compactRole === 'menuitem') return 'menuitem';
  return compactRole;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function parseBackgroundElementLines(stdout: string): BackgroundAxElement[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [indexText, role = '', name = '', axPath = '', frameText = ''] = line.split('\t');
      const index = Number.parseInt(indexText, 10);
      return {
        index: Number.isFinite(index) ? index : 0,
        role: role.trim(),
        name: name.trim(),
        axPath: axPath.trim(),
        frame: parseAxFrame(frameText),
      };
    })
    .filter((element) => element.index > 0 && element.role);
}

function parseBackgroundActionOutput(stdout: string, action: string, targetApp: string): {
  output: string;
  frame: BackgroundAxFrame | null;
} {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let frame: BackgroundAxFrame | null = null;
  const outputLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('AXFRAME\t')) {
      frame = parseAxFrame(line.slice('AXFRAME\t'.length));
      continue;
    }
    outputLines.push(line);
  }
  return {
    output: outputLines.join('\n') || `Background ${action} completed: ${targetApp}`,
    frame,
  };
}

function parseAxFrame(value: string): BackgroundAxFrame | null {
  const [x, y, width, height] = value
    .split(',')
    .map((part) => Number.parseFloat(part.trim()));
  if (
    Number.isFinite(x)
    && Number.isFinite(y)
    && Number.isFinite(width)
    && Number.isFinite(height)
    && width >= 0
    && height >= 0
  ) {
    return { x, y, width, height, coordSpace: 'screen' };
  }
  return null;
}

function formatAxFrame(frame: BackgroundAxFrame): string {
  return `${Math.round(frame.x)},${Math.round(frame.y)},${Math.round(frame.width)}x${Math.round(frame.height)}`;
}

function assessAxTreeQuality(elements: BackgroundAxElement[], reachedLimit: boolean): ComputerSurfaceAxQuality {
  const elementCount = elements.length;
  const labeledElementCount = elements.filter((element) => element.name.trim().length > 0).length;
  const withAxPathCount = elements.filter((element) => element.axPath.trim().length > 0).length;
  const unlabeledRatio = elementCount > 0 ? 1 - labeledElementCount / elementCount : 1;
  const missingAxPathRatio = elementCount > 0 ? 1 - withAxPathCount / elementCount : 1;
  const roleCounts: Record<string, number> = {};
  const labelRoleCounts = new Map<string, number>();
  for (const element of elements) {
    const role = element.role || 'unknown';
    roleCounts[role] = (roleCounts[role] || 0) + 1;
    const labelKey = `${role}:${element.name.trim().toLowerCase()}`;
    if (element.name.trim()) {
      labelRoleCounts.set(labelKey, (labelRoleCounts.get(labelKey) || 0) + 1);
    }
  }

  const duplicateLabelRoleCount = [...labelRoleCounts.values()]
    .filter((count) => count > 1)
    .reduce((sum, count) => sum + count, 0);
  const reasons: string[] = [];
  let score = 1;

  if (elementCount === 0) {
    reasons.push('no interactive AX elements returned');
    score = 0;
  } else {
    if (elementCount < 3) {
      reasons.push(`only ${elementCount} interactive AX element${elementCount === 1 ? '' : 's'} returned`);
      score -= 0.25;
    }
    if (unlabeledRatio > 0.35) {
      reasons.push(`${Math.round(unlabeledRatio * 100)}% of candidates are unlabeled`);
      score -= 0.3;
    } else if (unlabeledRatio > 0.1) {
      reasons.push(`${Math.round(unlabeledRatio * 100)}% of candidates are unlabeled`);
      score -= 0.1;
    }
    if (missingAxPathRatio > 0.2) {
      reasons.push(`${Math.round(missingAxPathRatio * 100)}% of candidates lack axPath`);
      score -= 0.2;
    }
    if (duplicateLabelRoleCount > 0) {
      reasons.push(`${duplicateLabelRoleCount} candidates share the same role/name`);
      score -= Math.min(0.25, duplicateLabelRoleCount / Math.max(1, elementCount));
    }
    if (reachedLimit) {
      reasons.push('candidate listing reached the requested limit');
      score -= 0.1;
    }
  }

  const clampedScore = Math.max(0, Math.min(1, score));
  const roundedScore = Math.round(clampedScore * 100) / 100;
  const grade: ComputerSurfaceAxQuality['grade'] = roundedScore >= 0.75
    ? 'good'
    : roundedScore >= 0.45
      ? 'usable'
      : 'poor';

  return {
    score: roundedScore,
    grade,
    elementCount,
    labeledElementCount,
    withAxPathCount,
    unlabeledRatio: Math.round(unlabeledRatio * 100) / 100,
    missingAxPathRatio: Math.round(missingAxPathRatio * 100) / 100,
    duplicateLabelRoleCount,
    roleCounts,
    reasons: reasons.length > 0 ? reasons : ['AX tree has enough labeled, addressable candidates'],
  };
}

function formatAxQualityLine(quality: ComputerSurfaceAxQuality): string {
  return `AX quality: ${quality.grade} score=${quality.score} (${quality.reasons.join('; ')})`;
}

function toAppleScriptArgs(lines: string[]): string[] {
  return lines.flatMap((line) => ['-e', line]);
}

function getExecStdout(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (Buffer.isBuffer(result)) {
    return result.toString('utf8');
  }
  if (result && typeof result === 'object' && 'stdout' in result) {
    const stdout = (result as { stdout?: string | Buffer }).stdout;
    return Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout || '';
  }
  return '';
}

function formatExecError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/\s+/g, ' ').trim();
  }
  return 'Unknown error';
}
