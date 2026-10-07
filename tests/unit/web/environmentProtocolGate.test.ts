// ADR-081 协议版本闸的纯判定单测：带 environmentSelection 的消息必须带
// environment-selection/1；缺版本/版本不符 → 拒绝（本轮不开始）；不带
// environmentSelection → 原样放行（默认本机，行为不变）。

import { describe, expect, it } from 'vitest';
import { checkEnvironmentProtocol } from '../../../src/web/routes/environmentProtocolGate';
import {
  ENVIRONMENT_PROTOCOL_UNSUPPORTED,
  ENVIRONMENT_SELECTION_PROTOCOL_VERSION,
  type TurnEnvironmentSelection,
} from '../../../src/shared/contract/executionEnvironment';

const selection: TurnEnvironmentSelection = {
  environmentId: 'env-cloud-prod',
  cwd: '/workspace/repo',
  workspaceRoots: ['/workspace/repo'],
  config: {
    internet: 'deny',
    credentialPlaceholders: [
      { placeholderId: 'gh', connectorId: 'github', destination: 'https://github.com' },
    ],
  },
};

const rejected = { supported: false, errorCode: ENVIRONMENT_PROTOCOL_UNSUPPORTED };

describe('checkEnvironmentProtocol（ADR-081 协议版本闸）', () => {
  it('不带 environmentSelection 的消息原样放行（本地默认路径不变）', () => {
    expect(checkEnvironmentProtocol(undefined)).toEqual({ supported: true });
    expect(checkEnvironmentProtocol({ prompt: 'hi' })).toEqual({ supported: true });
    expect(checkEnvironmentProtocol({ prompt: 'hi', protocolVersion: 'environment-selection/9' })).toEqual({ supported: true });
  });

  it('非对象 body 不在闸的职责内，放行交给后续 schema 校验', () => {
    expect(checkEnvironmentProtocol('prompt')).toEqual({ supported: true });
    expect(checkEnvironmentProtocol(42)).toEqual({ supported: true });
    expect(checkEnvironmentProtocol(null)).toEqual({ supported: true });
    expect(checkEnvironmentProtocol([selection])).toEqual({ supported: true });
  });

  it('① 带 environmentSelection 但缺 protocolVersion → 拒绝，只回稳定码', () => {
    expect(checkEnvironmentProtocol({ prompt: 'hi', environmentSelection: selection })).toEqual(rejected);
  });

  it('① 版本不是这一版（旧版号/未来版号/非字符串）→ 拒绝', () => {
    expect(checkEnvironmentProtocol({
      prompt: 'hi',
      environmentSelection: selection,
      protocolVersion: 'environment-selection/0',
    })).toEqual(rejected);
    expect(checkEnvironmentProtocol({
      prompt: 'hi',
      environmentSelection: selection,
      protocolVersion: 'environment-selection/2',
    })).toEqual(rejected);
    expect(checkEnvironmentProtocol({
      prompt: 'hi',
      environmentSelection: selection,
      protocolVersion: 1,
    })).toEqual(rejected);
    expect(checkEnvironmentProtocol({
      prompt: 'hi',
      environmentSelection: selection,
      protocolVersion: null,
    })).toEqual(rejected);
  });

  it('② 版本正确 → 放行（后续行为与不带该字段的消息一致）', () => {
    expect(checkEnvironmentProtocol({
      prompt: 'hi',
      environmentSelection: selection,
      protocolVersion: ENVIRONMENT_SELECTION_PROTOCOL_VERSION,
    })).toEqual({ supported: true });
  });

  it('environmentSelection 值残缺/为 null 也一样按「带了钥匙」处理：仍要求协议版本', () => {
    expect(checkEnvironmentProtocol({ prompt: 'hi', environmentSelection: null })).toEqual(rejected);
    expect(checkEnvironmentProtocol({ prompt: 'hi', environmentSelection: {} })).toEqual(rejected);
    // 版本正确但值残缺：闸只管版本，不在此处校验字段（交给后续施工单）
    expect(checkEnvironmentProtocol({
      prompt: 'hi',
      environmentSelection: null,
      protocolVersion: ENVIRONMENT_SELECTION_PROTOCOL_VERSION,
    })).toEqual({ supported: true });
  });
});
