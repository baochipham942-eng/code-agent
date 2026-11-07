import { describe, expect, it } from 'vitest';
import {
  EXECUTION_ENVIRONMENT_METADATA_KEY,
  readPersistedExecutionEnvironment,
} from '../../../src/shared/contract/executionEnvironmentMarker';

describe('executionEnvironmentMarker session metadata contract', () => {
  it('round-trips a valid cloud marker', () => {
    const marker = { kind: 'cloud', environmentId: 'cloud-1', setAt: 42 };
    expect(readPersistedExecutionEnvironment({ [EXECUTION_ENVIRONMENT_METADATA_KEY]: marker })).toEqual(marker);
    expect(readPersistedExecutionEnvironment({
      expertThread: { roleId: 'x', setAt: 1 },
      [EXECUTION_ENVIRONMENT_METADATA_KEY]: marker,
    })).toEqual(marker);
  });

  it('returns null for malformed values', () => {
    expect(readPersistedExecutionEnvironment(undefined)).toBeNull();
    expect(readPersistedExecutionEnvironment({})).toBeNull();
    // 非对象 / 数组 / null 值
    expect(readPersistedExecutionEnvironment({ [EXECUTION_ENVIRONMENT_METADATA_KEY]: 'cloud' })).toBeNull();
    expect(readPersistedExecutionEnvironment({ [EXECUTION_ENVIRONMENT_METADATA_KEY]: [{ kind: 'cloud', environmentId: 'c', setAt: 1 }] })).toBeNull();
    expect(readPersistedExecutionEnvironment({ [EXECUTION_ENVIRONMENT_METADATA_KEY]: null })).toBeNull();
    // 空 environmentId / 缺 environmentId
    expect(readPersistedExecutionEnvironment({ [EXECUTION_ENVIRONMENT_METADATA_KEY]: { kind: 'cloud', environmentId: '', setAt: 1 } })).toBeNull();
    expect(readPersistedExecutionEnvironment({ [EXECUTION_ENVIRONMENT_METADATA_KEY]: { kind: 'cloud', setAt: 1 } })).toBeNull();
    // wrong kind
    expect(readPersistedExecutionEnvironment({ [EXECUTION_ENVIRONMENT_METADATA_KEY]: { kind: 'local', environmentId: 'c', setAt: 1 } })).toBeNull();
    // 缺 / 非数值 setAt
    expect(readPersistedExecutionEnvironment({ [EXECUTION_ENVIRONMENT_METADATA_KEY]: { kind: 'cloud', environmentId: 'c' } })).toBeNull();
    expect(readPersistedExecutionEnvironment({ [EXECUTION_ENVIRONMENT_METADATA_KEY]: { kind: 'cloud', environmentId: 'c', setAt: 'soon' } })).toBeNull();
  });
});
