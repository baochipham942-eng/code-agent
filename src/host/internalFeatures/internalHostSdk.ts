import * as m1 from '../services/core/databaseService';
import * as m2 from '../services/core/sessionDefaults';
import * as m3 from '../services/core/configService';
import * as m4 from '../services/core/configDefaults';
import * as m5 from '../services/auth/authService';
import * as m6 from '../services/infra/logger';
import * as m7 from '../services/skills/skillRepositories';
import * as m8 from '../services/skills/skillDiscoveryService';
import * as m9 from '../platform';
import * as m10 from '../ipc/channelAccessPolicy';
import * as m11 from '../agent/runtime/turnTrace';
import * as m12 from '../agent/runtime/contextAssembly/requestManifestBuilder';
import * as m13 from '../agent/runtime/contextAssembly/ledgerMessageProjection';
import * as m14 from '../agent/runtime/contextAssembly/inferenceArtifactRepair';
import * as m15 from '../agent/runtime/scaffoldProfile';
import * as m16 from '../agent/loopTypes';
import * as m17 from '../agent/goalModeController';
import * as m18 from '../agent/agentRuntimeDefaults';
import * as m19 from '../telemetry/requestReplayBlobStore';
import * as m20 from '../telemetry/replay/telemetryQueryService';
import * as m21 from '../sandbox';
import * as m22 from '../model/quickModel';
import * as m23 from '../lightMemory/failureJournal';
import * as m24 from '../context/compressionPipeline';
import * as m25 from '../security/sensitiveDataGuard';
import * as m26 from '../security/commandSafety';
import { INTERNAL_SDK_VERSION } from './internalSdkVersion';

export const INTERNAL_HOST_SDK = Object.freeze({
  version: INTERNAL_SDK_VERSION.host,
  modules: Object.freeze({
    '@host/services/core/databaseService': m1,
    '@host/services/core/sessionDefaults': m2,
    '@host/services/core/configService': m3,
    '@host/services/core/configDefaults': m4,
    '@host/services/auth/authService': m5,
    '@host/services/infra/logger': m6,
    '@host/services/skills/skillRepositories': m7,
    '@host/services/skills/skillDiscoveryService': m8,
    '@host/platform': m9,
    '@host/ipc/channelAccessPolicy': m10,
    '@host/agent/runtime/turnTrace': m11,
    '@host/agent/runtime/contextAssembly/requestManifestBuilder': m12,
    '@host/agent/runtime/contextAssembly/ledgerMessageProjection': m13,
    '@host/agent/runtime/contextAssembly/inferenceArtifactRepair': m14,
    '@host/agent/runtime/scaffoldProfile': m15,
    '@host/agent/loopTypes': m16,
    '@host/agent/goalModeController': m17,
    '@host/agent/agentRuntimeDefaults': m18,
    '@host/telemetry/requestReplayBlobStore': m19,
    '@host/telemetry/replay/telemetryQueryService': m20,
    '@host/sandbox': m21,
    '@host/model/quickModel': m22,
    '@host/lightMemory/failureJournal': m23,
    '@host/context/compressionPipeline': m24,
    '@host/security/sensitiveDataGuard': m25,
    '@host/security/commandSafety': m26,
  }),
});
