// @vitest-environment jsdom
// ============================================================================
// 一个动作只讲一遍：改了哪个文件，一屏里只允许出现「正文一句 + 文件卡一处」
// ============================================================================
// 真机 dogfood 抓到：新建一个文件，同一件事被讲四遍——工具步骤行、行尾文件名徽标、
// 正文「已创建 x.txt。」、文件变更卡的路径行。卡片是四者里唯一带增删行数、diff
// 和撤销的那个，其余都是纯重复。
//
// 断言用的是「同一个文件名在可见文本里出现几次」，所以任何一条路径把它讲回来都会红。
// forceExpanded 是必须的：轮次卡折叠时中段根本不挂载，静态快照会假绿。
// ============================================================================
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

const FILE_PATH = '/work/neo-dogfood.txt';
const FILE_NAME = 'neo-dogfood.txt';

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function turnWithFileWrite(overrides?: { success?: boolean }): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status: 'completed',
    startTime: 100,
    endTime: 200,
    nodes: [
      { id: 'user-1', type: 'user', content: '建个文件', timestamp: 100 },
      {
        id: 'tool-1',
        type: 'tool_call',
        timestamp: 150,
        toolCall: {
          id: 'tc-1',
          name: 'Write',
          args: { file_path: FILE_PATH, content: '齿轮清单\n' },
          success: overrides?.success ?? true,
          result: overrides?.success === false
            ? 'EACCES: permission denied'
            : `Created file: ${FILE_PATH}`,
          shortDescription: `Create ${FILE_NAME} with gear list`,
        },
      },
      { id: 'assistant-1', type: 'assistant_text', content: `已创建 ${FILE_NAME}。`, timestamp: 190 },
    ],
  } as unknown as TraceTurn;
}

describe('文件改动只讲一遍', () => {
  it('成功写入：文件名只出现在正文和文件卡里，共两次', () => {
    render(React.createElement(TurnCard, { turn: turnWithFileWrite(), forceExpanded: true }));

    expect(countOccurrences(document.body.textContent ?? '', FILE_NAME)).toBe(2);
  });

  it('成功写入：模型自写的英文步骤描述不上屏', () => {
    render(React.createElement(TurnCard, { turn: turnWithFileWrite(), forceExpanded: true }));

    expect(document.body.textContent).not.toContain('Create ');
    expect(document.body.textContent).not.toContain('gear list');
  });

  it('写入失败：步骤行必须留着——不能让一次真的失败静默消失', () => {
    render(React.createElement(
      TurnCard,
      { turn: turnWithFileWrite({ success: false }), forceExpanded: true },
    ));

    // 失败的写入不进文件卡，所以它必须仍在节点流里出现（正文 1 次 + 步骤行 1 次）
    expect(countOccurrences(document.body.textContent ?? '', FILE_NAME)).toBeGreaterThan(1);
  });
});

afterEach(cleanup);
