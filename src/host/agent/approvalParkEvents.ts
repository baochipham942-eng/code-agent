// ============================================================================
// Approval-park internal event bus (B2 → B3 挂点)
// ============================================================================
//
// 无人值守工具审批停车/解决时各发一个进程内事件。B2 本体只负责 emit；
// B3（飞书镜像等外部通道）只订阅这两个事件，不改 B2 停车链路的代码。
// ============================================================================

import { EventEmitter } from 'node:events';

// ponytail: 事件 payload 只在本文件的 EventEmitter 泛型里用；B3 落地要跨模块消费时再加 export。
interface ApprovalParkedEvent {
  id: string;
  sessionId: string | null;
  tool: string;
  riskClass?: string | null;
}

interface ApprovalResolvedEvent {
  id: string;
  sessionId: string | null;
  status: 'approved' | 'rejected';
}

interface ApprovalParkEventMap {
  parked: [ApprovalParkedEvent];
  resolved: [ApprovalResolvedEvent];
}

// ponytail: 一个进程级 EventEmitter 足够；B3 落地前不需要持久化订阅表。
export const approvalParkEvents = new EventEmitter<ApprovalParkEventMap>();
