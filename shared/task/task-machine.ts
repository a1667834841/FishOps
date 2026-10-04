/**
 * 任务状态机定义与状态转换校验
 *
 * 规范 Task 状态生命周期、迁移边界、不可变更新及 MV3 Service Worker 重启恢复策略。
 */

import type { Task, TaskStatus } from '../types/task.ts';

/**
 * 状态机内部支持的扩展任务状态类型（包含 waiting_confirmation）
 */
export type MachineTaskStatus = TaskStatus | 'waiting_confirmation';

/**
 * 终态集合：处于终态的任务不允许再发生任何状态迁移
 */
export const TERMINAL_STATUSES: ReadonlySet<MachineTaskStatus> = new Set<MachineTaskStatus>([
  'completed',
  'failed',
  'cancelled',
]);

/**
 * 合法状态迁移有向图映射表
 * Key: 源状态 -> Value: 允许转换的目标状态集合
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<MachineTaskStatus, readonly MachineTaskStatus[]>> = {
  pending: ['running', 'cancelled'],
  running: ['paused', 'completed', 'failed', 'cancelled', 'waiting_confirmation'],
  // paused → pending：恢复采集时先重新排队（pending），真正出队执行时才转 running；
  // 保留首次 startedAt，便于前端展示真实执行起点。
  paused: ['running', 'pending', 'failed', 'cancelled', 'waiting_confirmation'],
  waiting_confirmation: ['completed', 'failed', 'cancelled', 'paused'],
  completed: [],
  failed: [],
  cancelled: [],
};

/**
 * 非法状态迁移异常
 */
export class InvalidTaskTransitionError extends Error {
  public readonly taskId: string;
  public readonly fromStatus: string;
  public readonly toStatus: string;

  constructor(taskId: string, fromStatus: string, toStatus: string, reason?: string) {
    const detail = reason ? ` (${reason})` : '';
    super(
      `[TaskMachine] 非法状态迁移: 任务 "${taskId}" 不能从 "${fromStatus}" 转换到 "${toStatus}"${detail}`,
    );
    this.name = 'InvalidTaskTransitionError';
    this.taskId = taskId;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

/**
 * 判断指定状态是否为终态 (completed / failed / cancelled)
 */
export function isTerminalStatus(status: MachineTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * 判断从当前状态迁移到目标状态是否合法
 *
 * @param from 当前状态
 * @param to 期望目标状态
 */
export function canTransition(from: MachineTaskStatus, to: MachineTaskStatus): boolean {
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * 断言状态转换是否合法，若不合法直接抛出 InvalidTaskTransitionError
 */
export function assertValidTransition(
  taskId: string,
  from: MachineTaskStatus,
  to: MachineTaskStatus,
  reason?: string,
): void {
  if (!canTransition(from, to)) {
    throw new InvalidTaskTransitionError(taskId, from, to, reason);
  }
}

/**
 * 任务状态迁移补丁字段
 */
export interface TransitionPatch {
  /** 任务进度 (0 - 100) */
  progress?: number;
  /** 执行结果 (通常在 completed 时附加) */
  result?: unknown;
  /** 错误描述 (通常在 failed 时附加) */
  error?: string;
  /** 元数据更新 (浅合并到原 meta) */
  meta?: Record<string, unknown>;
  /** 自定义更新时间，缺省使用 Date.now() */
  timestamp?: number;
}

/**
 * 执行不可变任务状态迁移
 *
 * 处理规则：
 * 1. 严格校验状态迁移合法性，拒绝非法流转。
 * 2. 状态保持不可变（返回新的深/浅拷贝对象），禁止原地修改传入引用。
 * 3. 自动维护关键时间戳：
 *    - 每次迁移更新 updatedAt
 *    - 首次进入 running 状态且未有 startedAt 时记录 startedAt
 *    - 达到终态 (completed / failed / cancelled) 时记录 endedAt
 * 4. 进度值边界保护 (0 <= progress <= 100)。
 *
 * @param task 原始任务对象
 * @param nextStatus 目标状态
 * @param patch 伴随状态变更的补充数据
 */
export function transitionTask<T extends Task<any, any, any, any, any>>(
  task: T,
  nextStatus: MachineTaskStatus,
  patch: TransitionPatch = {},
): T {
  assertValidTransition(task.id, task.status as MachineTaskStatus, nextStatus);

  const now = patch.timestamp ?? Date.now();
  const nextProgress = patch.progress !== undefined
    ? Math.max(0, Math.min(100, patch.progress))
    : task.progress;

  const updated: Task = {
    ...task,
    status: nextStatus,
    progress: nextProgress,
    updatedAt: now,
    meta: {
      ...task.meta,
      ...patch.meta,
    },
  };

  // 记录首次启动时间
  if (nextStatus === 'running' && !updated.startedAt) {
    updated.startedAt = now;
  }

  // 进入终态时记录结束时间
  if (isTerminalStatus(nextStatus) && !updated.endedAt) {
    updated.endedAt = now;
  }

  // 写入执行结果或错误
  if (patch.result !== undefined) {
    updated.result = patch.result as any;
  }
  if (patch.error !== undefined) {
    updated.error = patch.error;
  }

  return updated as T;
}

/**
 * MV3 Service Worker 重启时的恢复策略选项
 *
 * - 'paused': (默认策略) 将 running 任务置为 paused，保留当前进度与入参。
 *   原因：MV3 Service Worker 存在 30 秒无通信即被浏览器自动停用销毁的机制。
 *   当 Service Worker 被重新唤醒时，内存中原本执行中的异步句柄已丢失，但底层持久化数据
 *   保留了断点（例如采集任务已采集 40/100 条）。转为 paused 可允许调度器或用户在 Workbench
 *   中安全断点续跑，避免全量重跑带来的风控和性能损耗。
 *
 * - 'failed': 将 running 任务直接置为 failed，并记录重启中断原因。
 *   适用场景：非幂等任务（如原子发布任务已提交到一半，无法确定远端是否完成），
 *   此时断点续跑可能导致重复发布，标记 failed 更为安全可靠。
 */
export type RecoveryStrategy = 'paused' | 'failed';

export interface RecoveryOptions {
  /** 恢复策略，默认 'paused' */
  strategy?: RecoveryStrategy;
  /** 附加恢复原因说明 */
  reason?: string;
  /** 恢复时间戳 */
  timestamp?: number;
}

/**
 * Service Worker 启动/唤醒后恢复中断任务的统一状态入口。
 *
 * 仅对处于 'running' 状态的孤儿任务执行恢复流转；非 running 状态的任务保持原样返回。
 *
 * @param task 原始任务
 * @param options 恢复配置
 */
export function recoverTaskAfterRestart<T extends Task>(
  task: T,
  options: RecoveryOptions = {},
): T {
  if (task.status !== 'running') {
    return task;
  }

  const strategy = options.strategy ?? 'paused';
  const defaultReason = strategy === 'paused'
    ? 'Service Worker 重启，运行中任务自动挂起为 paused，等待续跑'
    : 'Service Worker 重启，运行中任务已被中断终止';
  const note = options.reason ?? defaultReason;
  const now = options.timestamp ?? Date.now();

  const metaPatch = {
    recoveryNote: note,
    recoveredAt: now,
  };

  if (strategy === 'paused') {
    // running -> paused 是合法流转，保留既有 progress
    return transitionTask(task, 'paused', {
      meta: metaPatch,
      timestamp: now,
    });
  } else {
    // running -> failed 是合法流转
    return transitionTask(task, 'failed', {
      error: note,
      meta: metaPatch,
      timestamp: now,
    });
  }
}
