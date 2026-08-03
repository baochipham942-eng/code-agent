/** 画布实体的创建者。多人协作归因不在本层范围内。 */
export type CanvasActor = 'user' | 'agent';

/**
 * 三类画布实体共享的最小归因账本。
 * userTouchedAt 有值即表示用户曾修改过该实体；0 是历史/损坏存档的 fail-closed 哨兵。
 */
export interface CanvasAttribution {
  createdBy: CanvasActor;
  userTouchedAt?: number;
}

/** 新实体进入 store 前可省略归因，由 action 根据 actor 统一盖章。 */
export type CanvasEntityInput<T> = T extends CanvasAttribution
  ? Omit<T, keyof CanvasAttribution> & Partial<CanvasAttribution>
  : never;

export type CanvasEntityPatch<T> = T extends CanvasAttribution
  ? Partial<Omit<T, keyof CanvasAttribution>>
  : never;

export function isCanvasActor(value: unknown): value is CanvasActor {
  return value === 'user' || value === 'agent';
}

export function hasUserTouch(entity: Pick<CanvasAttribution, 'userTouchedAt'>): boolean {
  return entity.userTouchedAt !== undefined;
}
