import { describe, expect, it } from 'vitest';
import { shouldCreateRoleDirectly } from '../../../../src/host/services/roleAssets/roleCreationIntent';

describe('shouldCreateRoleDirectly', () => {
  it.each([
    '创建一个日历专家，直接创建',
    '不用再问我问题，按刚才说的创建',
    '这个角色不用确认，直接做吧',
    '/create-role 创建一个专家，名字叫「日历助理」，职责：每天帮我盯日程',
  ])('明确创建意图直接安装：%s', (text) => {
    expect(shouldCreateRoleDirectly(text)).toBe(true);
  });

  it.each([
    '帮我想想要不要建个日程专家',
    '也许以后可以有个日程助手',
    '/create-role 日历助理',
    '/create-role 名字叫「日历助理」',
    '/create-role 职责：每天帮我盯日程',
    '模型建议创建一个日程专家',
    '请不要直接创建，先给我看看',
    '不用直接创建，先出个草稿给我看',
    '不是让你直接创建，先给我看草稿',
    '无需直接创建',
    '不必直接创建',
    '别急着直接创建',
    '直接创建还是先确认？',
    '是否直接创建比较好？',
    '',
  ])('含糊或模型提议仍需确认：%s', (text) => {
    expect(shouldCreateRoleDirectly(text)).toBe(false);
  });
});
