// ============================================================================
// 用户可见 system 事件登记表（P0-2，2026-08-07）
//
// role:'system' 的落库消息默认是只给模型看的内部指令（真库 635 条全是
// <failed-run-continuation-context> 这类），投影层总闸一律跳过。少数几类
// 是用户必须看见的事件（通话摘要、通话失败、派活失败、派活结局）——以前靠
// 渲染端人工维护白名单，漏一项就是「模型读得到、用户屏幕上空白、历史找不回」
// （#908：voiceCallFailure 漏登记，隔 11 个 PR 才被真机撞见）。
//
// 登记制把「谁该给用户看」挪到写入侧：
// - 投影层按本表查表渲染，未登记的 system 消息照旧跳过（总闸不拆）；
// - 写入侧落库 system 消息的 metadata 键必须来自本表（含 internal 档），
//   写错键在编译期报错（SystemEventMessageMetadata）；
// - 未登记的键出现在 system 消息上：开发档 console.error + 契约测试报红，
//   生产档维持现状跳过。
// ============================================================================

import type { MessageMetadata } from './message';
import type { TraceNode } from './trace';

/** 呈现类型：error / info / summary 投成节点；settle 不成节点，只把结局盖到所属轮上。 */
type SystemEventPresentation = 'error' | 'info' | 'summary' | 'settle';

export interface UserVisibleSystemEventSpec {
  presentation: SystemEventPresentation;
  /** 投出的 TraceNode.subtype；settle 不成节点，无此字段。 */
  subtype?: NonNullable<TraceNode['subtype']>;
  /**
   * 挂轮策略：
   * - current-turn：挂当前轮，没有轮就独立成轮；
   * - matched-turn：按 payload.workItemId 对回带 voiceDispatch 的派活轮，
   *   对不上时节点类退到当前轮/独立成轮，settle 类直接丢弃（章不能盖到别人的活头上）。
   */
  attach: 'current-turn' | 'matched-turn';
}

/**
 * 用户可见 system 事件登记表：metadata 键 → 呈现方式。
 * 新增事件 = 在 MessageMetadata 加键 + 在这里登记，投影层契约测试自动多一条用例。
 */
export const USER_VISIBLE_SYSTEM_EVENT_REGISTRY = {
  voiceCallSummary: { presentation: 'summary', subtype: 'voice_call_summary', attach: 'current-turn' },
  voiceCallFailure: { presentation: 'error', subtype: 'error', attach: 'current-turn' },
  voiceWorkFailure: { presentation: 'error', subtype: 'error', attach: 'matched-turn' },
  voiceWorkSettled: { presentation: 'settle', attach: 'matched-turn' },
  // 无专属 subtype——落进 TraceNodeRenderer 的通用 system 节点渲染（纯文本、不打断），
  // 与「弹 toast 打断」的 agent:notice 通道正交（ADR：2026-08-08 notification 零消费者工单乙类）。
  agentRecoveryNotice: { presentation: 'info', attach: 'current-turn' },
} as const satisfies Record<string, UserVisibleSystemEventSpec>;

export type UserVisibleSystemEventKey = keyof typeof USER_VISIBLE_SYSTEM_EVENT_REGISTRY;

// 登记表的键必须是 MessageMetadata 上真实存在的键——登记了一个契约里没有的键在编译期报错。
type AssertRegistryKeysExistInMessageMetadata =
  UserVisibleSystemEventKey extends keyof MessageMetadata ? true : never;
const _registryKeysExist: AssertRegistryKeysExistInMessageMetadata = true;
void _registryKeysExist;

/**
 * 允许出现在 role:'system' 消息上、但不构成用户可见事件的 metadata 键（内部投影用，
 * 投影层静默跳过）。写 system 消息时用到本档以外的未登记键，开发档会报错。
 */
const INTERNAL_SYSTEM_METADATA_KEYS = ['backgroundTaskResult'] as const;
type InternalSystemMetadataKey = (typeof INTERNAL_SYSTEM_METADATA_KEYS)[number];

/** 通用标注轴（任何 role 的消息都可能带），不参与 system 事件的登记判定。 */
const SYSTEM_METADATA_ANNOTATION_KEYS: ReadonlySet<string> = new Set([
  'source',
  'correlation',
  'voiceTranscript',
]);

/**
 * 写入侧类型约束：role:'system' 消息落库时的 metadata 键必须来自登记表
 * （用户可见事件 / 内部投影档）或通用标注轴。想写一个新键？先去登记表登记，
 * 否则这里编译期就报错——「漏登记」从静默丢数据变成类型错。
 */
export type SystemEventMessageMetadata = {
  [K in UserVisibleSystemEventKey]?: MessageMetadata[K];
} & {
  [K in InternalSystemMetadataKey]?: MessageMetadata[K];
} & Pick<MessageMetadata, 'source' | 'correlation' | 'voiceTranscript'>;

export interface RegisteredSystemEvent {
  key: UserVisibleSystemEventKey;
  spec: UserVisibleSystemEventSpec;
  payload: NonNullable<MessageMetadata[UserVisibleSystemEventKey]>;
}

/** 查表：metadata 里第一个已登记的用户可见事件键；都没有返回 undefined。 */
export function findRegisteredSystemEvent(
  metadata: MessageMetadata | undefined,
): RegisteredSystemEvent | undefined {
  if (!metadata) return undefined;
  for (const key of Object.keys(USER_VISIBLE_SYSTEM_EVENT_REGISTRY) as UserVisibleSystemEventKey[]) {
    const payload = metadata[key];
    if (payload) {
      return { key, spec: USER_VISIBLE_SYSTEM_EVENT_REGISTRY[key], payload };
    }
  }
  return undefined;
}

/**
 * metadata 里「看起来像事件却没登记」的键：不在用户可见表、不在内部投影档、
 * 也不是通用标注轴。投影层据此在开发档报错（生产档静默跳过，维持现状）。
 */
export function findUnregisteredSystemEventKeys(metadata: MessageMetadata): string[] {
  const internal = new Set<string>(INTERNAL_SYSTEM_METADATA_KEYS);
  return Object.keys(metadata).filter((key) => (
    !(key in USER_VISIBLE_SYSTEM_EVENT_REGISTRY)
    && !internal.has(key)
    && !SYSTEM_METADATA_ANNOTATION_KEYS.has(key)
  ));
}
