import { DOCTOR_FIX_CODES } from '../../../shared/constants/doctor';
import { OS_SANDBOX_DOCTOR_ITEM_NAME } from '../../../shared/constants/sandbox';
import { probeOsSandbox } from '../../sandbox/probe';
import type { DoctorItem } from '../types';

export function checkOsSandbox(): DoctorItem {
  const probe = probeOsSandbox();
  const technology = probe.technology ? `${probe.technology}${probe.version ? ` ${probe.version}` : ''}` : probe.platform;
  if (probe.available && probe.enabled) {
    return {
      category: 'environment',
      name: OS_SANDBOX_DOCTOR_ITEM_NAME,
      status: 'pass',
      message: `available · ${technology}`,
      details: [
        probe.writePolicy,
        probe.networkPolicy,
        `rollout: ${probe.rolloutModes.join(', ')}`,
      ].join('\n'),
    };
  }
  if (!probe.enabled) {
    return {
      category: 'environment',
      name: OS_SANDBOX_DOCTOR_ITEM_NAME,
      status: 'warn',
      message: 'disabled by OS_SANDBOX_ENABLED=false',
      details: probe.installHint,
      suggestion: 'Unset OS_SANDBOX_ENABLED to restore the default-on OS sandbox.',
      fix: { code: DOCTOR_FIX_CODES.OPEN_RUNTIME_HELP },
    };
  }
  return {
    category: 'environment',
    name: OS_SANDBOX_DOCTOR_ITEM_NAME,
    status: 'warn',
    message: probe.error ? `unavailable · ${probe.error}` : `unavailable · ${probe.platform}`,
    details: probe.installHint,
    suggestion: probe.installHint,
    fix: { code: DOCTOR_FIX_CODES.OPEN_RUNTIME_HELP },
  };
}
