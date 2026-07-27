// ============================================================================
// doctorStore - 全量诊断（Doctor）前端状态
// - 启动后静默快检结果存这里，侧栏徽标与诊断弹层共用同一份报告
// - 弹层打开时复用已有报告；无报告则自动跑一次全量
// - 错误不抛出：写 lastError 由弹层内联展示（静默快检失败则完全吞掉，不打扰）
// ============================================================================

import { create } from 'zustand';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import {
  hasDoctorFailures,
  mergeDoctorCategoryReport,
  type DoctorCategory,
  type DoctorReport,
  type RunDoctorOptions,
} from '../types/doctor';

/** 启动后延迟静默快检的时间（约 10s，等应用完全加载） */
export const DOCTOR_STARTUP_CHECK_DELAY_MS = 10_000;

interface DoctorState {
  report: DoctorReport | null;
  /** 全量 / 单类重跑进行中（弹层内展示 loading） */
  isRunning: boolean;
  /** 正在单类重检的分类；null 表示不是单类重检 */
  runningCategory: DoctorCategory | null;
  isDialogOpen: boolean;
  /** 最近一次手动/全量运行的错误信息；成功或新一轮运行时清空 */
  lastError: string | null;
  /** 启动静默快检是否已跑过（不管结果如何只跑一次） */
  startupCheckDone: boolean;

  openDialog: () => void;
  closeDialog: () => void;
  /** 全量重跑 */
  runFull: () => Promise<void>;
  /** 单类重检，结果合并回整报告 */
  runCategory: (category: DoctorCategory) => Promise<void>;
  /** 启动静默快检：skipNetwork、失败静默、不打扰（只为侧栏徽标准备数据） */
  runSilentStartupCheck: () => Promise<void>;
}

async function invokeDoctor(options?: RunDoctorOptions): Promise<DoctorReport> {
  return ipcService.invokeDomain<DoctorReport>(IPC_DOMAINS.PROVIDER, 'run_doctor', options);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useDoctorStore = create<DoctorState>()((set, get) => ({
  report: null,
  isRunning: false,
  runningCategory: null,
  isDialogOpen: false,
  lastError: null,
  startupCheckDone: false,

  openDialog: () => {
    set({ isDialogOpen: true });
    // 弹层打开时复用已有报告（如启动静默快检的结果）；没有则自动跑全量
    if (!get().report && !get().isRunning) {
      void get().runFull();
    }
  },

  closeDialog: () => set({ isDialogOpen: false }),

  runFull: async () => {
    if (get().isRunning) return;
    set({ isRunning: true, runningCategory: null, lastError: null });
    try {
      const report = await invokeDoctor();
      set({ report });
    } catch (err) {
      set({ lastError: errorMessage(err) });
    } finally {
      set({ isRunning: false });
    }
  },

  runCategory: async (category) => {
    if (get().isRunning) return;
    set({ isRunning: true, runningCategory: category, lastError: null });
    try {
      const partial = await invokeDoctor({ category });
      set({ report: mergeDoctorCategoryReport(get().report, category, partial) });
    } catch (err) {
      set({ lastError: errorMessage(err) });
    } finally {
      set({ isRunning: false, runningCategory: null });
    }
  },

  runSilentStartupCheck: async () => {
    if (get().startupCheckDone) return;
    set({ startupCheckDone: true });
    try {
      const report = await invokeDoctor({ skipNetwork: true });
      // 静默期间用户可能已手动跑过更新的全量，别用旧的快检覆盖
      if (!get().report) set({ report });
    } catch {
      // 静默快检失败不打扰用户：不亮徽标、不弹错误
    }
  },
}));

export { hasDoctorFailures };
