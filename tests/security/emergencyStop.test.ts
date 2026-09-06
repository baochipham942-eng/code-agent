import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstatSync } from 'node:fs';
vi.mock('node:fs', () => ({ lstatSync: vi.fn() }));
import { isEmergencyStopActive } from '../../src/host/security/emergencyStop';
import { emergencyStopMessage } from '../../src/shared/i18n/emergencyStop';

vi.mock('../../src/host/config/configPaths', () => ({ getUserConfigDir: () => '/virtual/estop-test' }));
afterEach(() => vi.restoreAllMocks());
describe('emergency stop fail-safe', () => {
  it.each(['EACCES', 'EPERM', 'EIO', 'ENOTDIR'])('stops on %s', (code) => {
    vi.mocked(lstatSync).mockImplementation(() => { throw Object.assign(new Error('unreadable'), { code }); });
    expect(isEmergencyStopActive()).toBe(true);
  });
  it('continues only when the sentinel is absent', () => {
    vi.mocked(lstatSync).mockImplementation(() => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); });
    expect(isEmergencyStopActive()).toBe(false);
  });
  it('provides one line in both languages', () => {
    expect(emergencyStopMessage('zh-CN')).toContain('已暂停新操作');
    expect(emergencyStopMessage('en-US')).toContain('New actions are paused');
  });
});
