import { describe, expect, it } from 'vitest';
import {
  activateArtifactRepairAdmissionStop,
  ARTIFACT_REPAIR_STOP_PREFIXES,
} from '../../../src/main/agent/runtime/artifactRepairAdmission';
import { ARTIFACT_REPAIR_MAX_ATTEMPTS } from '../../../src/shared/constants/repair';

function makeCtx(): any {
  return { forceFinalResponseReason: undefined, forceFinalResponsePrompt: undefined };
}

describe('activateArtifactRepairAdmissionStop — Route A 硬停闸', () => {
  it('unavailable-tool 停闸：用对应前缀写入 forceFinalResponseReason/Prompt', () => {
    const ctx = makeCtx();
    activateArtifactRepairAdmissionStop(ctx, '/tmp/game.html', 'Grep, Bash');

    expect(ctx.forceFinalResponseReason).toBe(
      `${ARTIFACT_REPAIR_STOP_PREFIXES['unavailable-tool']} Grep, Bash`,
    );
    expect(ctx.forceFinalResponsePrompt).toContain('<force-final-response');
    expect(ctx.forceFinalResponsePrompt).toContain('/tmp/game.html');
    expect(ctx.forceFinalResponsePrompt).toContain('repeatedly requested unavailable tool');
  });

  it('attempts-exhausted 停闸：用独立前缀和措辞', () => {
    const ctx = makeCtx();
    const detail = `${ARTIFACT_REPAIR_MAX_ATTEMPTS}/${ARTIFACT_REPAIR_MAX_ATTEMPTS} attempts`;
    activateArtifactRepairAdmissionStop(ctx, '/tmp/game.html', detail, 'attempts-exhausted');

    expect(ctx.forceFinalResponseReason).toBe(
      `${ARTIFACT_REPAIR_STOP_PREFIXES['attempts-exhausted']} ${detail}`,
    );
    expect(ctx.forceFinalResponseReason.startsWith(ARTIFACT_REPAIR_STOP_PREFIXES['unavailable-tool'])).toBe(false);
    expect(ctx.forceFinalResponsePrompt).toContain('reached its attempt limit');
  });

  it('两种停闸前缀互不重叠，UI 处理器可区分', () => {
    expect(ARTIFACT_REPAIR_STOP_PREFIXES['unavailable-tool']).not.toBe(
      ARTIFACT_REPAIR_STOP_PREFIXES['attempts-exhausted'],
    );
    expect(
      ARTIFACT_REPAIR_STOP_PREFIXES['attempts-exhausted'].startsWith(
        ARTIFACT_REPAIR_STOP_PREFIXES['unavailable-tool'],
      ),
    ).toBe(false);
  });
});
