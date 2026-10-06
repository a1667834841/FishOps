/**
 * 任务管理器核心实现
 *
 * 负责任务的完整生命周期管理：创建、启动、暂停、恢复、取消、完成、失败及进度更新。
 * 强制校验状态机流转合法性，所有写操作经由 TaskStore 持久化，
 * 并支持发布/订阅机制与快照分发，保证状态单向安全流动。
 */

import type {
  CreateTaskInput,
  Task,
  TaskChangeEvent,
  TaskChangeListener,
  TaskFilter,
  TaskStatus,
  TaskType,
} from '../types/task.ts';
import {
  recoverTaskAfterRestart,
  transitionTask,
} from './task-machine.ts';
import type {
  RecoveryOptions,
} from './task-machine.ts';
import {
  cloneTask,
  withTaskUpdateLock,
  createDefaultTaskStore,
} from './task-store.ts';
import type {
  TaskStore,
} from './task-store.ts';

/**
 * 任务不存在异常
 */
export class TaskNotFoundError extends Error {
  public readonly taskId: string;

  constructor(taskId: string) {
    super(`[TaskManager] 未找到 ID 为 "${taskId}" 的任务`);
    this.name = 'TaskNotFoundError';
    this.taskId = taskId;
  }
}

/**
 * 生成安全的随机唯一任务 ID
 */
export function generateTaskId(type: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${type}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }
  const randomPart = Math.random().toString(36).substring(2, 10);
  const timePart = Date.now().toString(36);
  return `${type}_${timePart}_${randomPart}`;
}

/**
 * TaskManager 构造配置
 */
export interface TaskManagerOptions {
  /** 任务存储后端，缺省时自动使用 Chrome Session / 内存存储 */
  store?: TaskStore;
  /** 自定义 ID 生成器 */
  idGenerator?: (type: TaskType) => string;
}

/** 启动恢复配置；未指定类型时保留全类型恢复，模块初始化必须指定所属类型。 */
export interface StartupRecoveryOptions extends RecoveryOptions {
  /** 仅恢复该类型的 running 任务，不改写其他类型的状态或元数据。 */
  type?: TaskType;
}

/**
 * 任务管理器核心实现
 */
export class TaskManager {
  private readonly store: TaskStore;
  private readonly listeners = new Set<TaskChangeListener>();
  private readonly idGenerator: (type: TaskType) => string;

  constructor(options: TaskManagerOptions = {}) {
    this.store = options.store ?? createDefaultTaskStore();
    this.idGenerator = options.idGenerator ?? generateTaskId;
  }

  /**
   * 注册任务变更事件监听器
   *
   * 回调接收的 Task 均已深拷贝快照化，外部修改不会污染存储中的真实状态。
   * @returns 取消订阅的清理函数
   */
  public subscribe(listener: TaskChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 广播任务变更事件给所有监听者
   */
  private notify(
    eventType: TaskChangeEvent['eventType'],
    task: Task,
    previousStatus?: string,
  ): void {
    if (this.listeners.size === 0) return;

    const event: TaskChangeEvent = {
      eventType,
      task: cloneTask(task),
      previousStatus: previousStatus as TaskStatus | undefined,
      timestamp: Date.now(),
    };

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // 隔离单个 listener 异常，避免中断后续分发
        console.error('[TaskManager] 事件监听器抛出异常:', err);
      }
    }
  }

  /**
   * 根据 ID 检索任务，内部保证返回独立快照
   */
  public async getById(id: string): Promise<Task | null> {
    const task = await this.store.get(id);
    return task ? cloneTask(task) : null;
  }

  /**
   * 严格获取任务，若任务不存在则抛出 TaskNotFoundError
   */
  private async getRequiredTask(id: string): Promise<Task> {
    const task = await this.store.get(id);
    if (!task) {
      throw new TaskNotFoundError(id);
    }
    return task;
  }

  /**
   * 查询符合过滤条件的任务列表
   */
  public async list(filter?: TaskFilter): Promise<Task[]> {
    const tasks = await this.store.list(filter);
    return tasks.map(cloneTask);
  }

  /**
   * 创建新任务（初始状态为 pending，progress = 0）
   */
  public async create<TType extends TaskType>(
    input: CreateTaskInput<TType>,
  ): Promise<Task<TType>> {
    const now = Date.now();
    const id = input.id ?? this.idGenerator(input.type);

    return withTaskUpdateLock(this.store, id, async () => {
      // 查重保护，防止覆盖已有任务
      const existing = await this.store.get(id);
      if (existing) {
        throw new Error(`[TaskManager] 任务 ID "${id}" 已存在，不可重复创建`);
      }

      const task: Task<TType> = {
        id,
        type: input.type,
        status: 'pending',
        progress: 0,
        createdAt: now,
        updatedAt: now,
        payload: input.payload,
        meta: (input.meta ?? {}) as any,
      };

      await this.store.save(task);
      this.notify('created', task);

      return cloneTask(task);
    });
  }

  /**
   * 启动任务 (pending -> running)
   */
  public async start(id: string): Promise<Task> {
    return withTaskUpdateLock(this.store, id, async () => {
      const current = await this.getRequiredTask(id);
      const prevStatus = current.status;
      const next = transitionTask(current, 'running');

      await this.store.save(next);
      this.notify('updated', next, prevStatus);
      return cloneTask(next);
    });
  }

  /**
   * 暂停任务 (running -> paused)
   */
  public async pause(id: string, reason?: string): Promise<Task> {
    return withTaskUpdateLock(this.store, id, async () => {
      const current = await this.getRequiredTask(id);
      const prevStatus = current.status;
      const next = transitionTask(current, 'paused', {
        meta: reason ? { pauseReason: reason } : undefined,
      });

      await this.store.save(next);
      this.notify('updated', next, prevStatus);
      return cloneTask(next);
    });
  }

  /**
   * 恢复暂停中的任务 (paused -> running)
   */
  public async resume(id: string): Promise<Task> {
    return withTaskUpdateLock(this.store, id, async () => {
      const current = await this.getRequiredTask(id);
      const prevStatus = current.status;
      const next = transitionTask(current, 'running');

      await this.store.save(next);
      this.notify('updated', next, prevStatus);
      return cloneTask(next);
    });
  }

  /**
   * 重新排队任务 (paused -> pending)
   *
   * 用于「恢复采集」：先把 paused 任务持久化为 pending 重新入队，真正出队执行
   * 时才转为 running；transitionTask 会保留首次 startedAt（不重置为出队时间）。
   */
  public async requeue(id: string): Promise<Task> {
    return withTaskUpdateLock(this.store, id, async () => {
      const current = await this.getRequiredTask(id);
      const prevStatus = current.status;
      const next = transitionTask(current, 'pending');

      await this.store.save(next);
      this.notify('updated', next, prevStatus);
      return cloneTask(next);
    });
  }

  /**
   * 取消任务 (pending | running | paused -> cancelled)
   */
  public async cancel(id: string, reason?: string): Promise<Task> {
    return withTaskUpdateLock(this.store, id, async () => {
      const current = await this.getRequiredTask(id);
      const prevStatus = current.status;
      const next = transitionTask(current, 'cancelled', {
        error: reason,
        meta: reason ? { cancelReason: reason } : undefined,
      });

      await this.store.save(next);
      this.notify('updated', next, prevStatus);
      return cloneTask(next);
    });
  }

  /**
   * 标记任务执行成功 (running -> completed)
   */
  public async complete(id: string, result?: unknown): Promise<Task> {
    return withTaskUpdateLock(this.store, id, async () => {
      const current = await this.getRequiredTask(id);
      const prevStatus = current.status;
      const next = transitionTask(current, 'completed', {
        progress: 100,
        result,
      });

      await this.store.save(next);
      this.notify('updated', next, prevStatus);
      return cloneTask(next);
    });
  }

  /**
   * 标记任务进入等待人工确认状态 (running | paused -> waiting_confirmation)
   */
  public async waitForConfirmation(
    id: string,
    patch?: { result?: unknown; progress?: number; meta?: Record<string, unknown> },
  ): Promise<Task> {
    return withTaskUpdateLock(this.store, id, async () => {
      const current = await this.getRequiredTask(id);
      const prevStatus = current.status;
      const next = transitionTask(current, 'waiting_confirmation', {
        progress: patch?.progress ?? 100,
        result: patch?.result,
        meta: patch?.meta,
      });

      await this.store.save(next);
      this.notify('updated', next, prevStatus);
      return cloneTask(next);
    });
  }

  /**
   * 标记任务执行失败 (running | paused -> failed)
   */
  public async fail(id: string, error: string): Promise<Task> {
    return withTaskUpdateLock(this.store, id, async () => {
      const current = await this.getRequiredTask(id);
      const prevStatus = current.status;
      const next = transitionTask(current, 'failed', {
        error,
      });

      await this.store.save(next);
      this.notify('updated', next, prevStatus);
      return cloneTask(next);
    });
  }

  /**
   * 更新任务进度 (仅在 running 或 paused 状态下允许更新)
   */
  public async updateProgress(
    id: string,
    progress: number,
    metaPatch?: Record<string, unknown>,
  ): Promise<Task> {
    return withTaskUpdateLock(this.store, id, async () => {
      const current = await this.getRequiredTask(id);

      if (current.status !== 'running' && current.status !== 'paused') {
        throw new Error(
          `[TaskManager] 无法更新状态为 "${current.status}" 的任务进度 (仅允许 running / paused 状态更新进度)`,
        );
      }

      const safeProgress = Math.max(0, Math.min(100, progress));
      const now = Date.now();

      const updated: Task = {
        ...current,
        progress: safeProgress,
        updatedAt: now,
        meta: {
          ...current.meta,
          ...metaPatch,
        },
      };

      await this.store.save(updated);
      this.notify('updated', updated, current.status);
      return cloneTask(updated);
    });
  }

  /**
   * Service Worker 启动/唤醒后执行的孤儿任务恢复
   *
   * 扫描指定类型（未指定时为所有类型）的遗留 running 任务，按策略转为 paused（默认）或 failed。
   * 共享存储的模块必须限定类型，避免初始化顺序导致其他模块的恢复策略和断点失效。
   *
   * @param options 恢复配置 (默认策略 'paused'，可指定任务类型)
   * @returns 成功恢复的任务列表
   */
  public async recoverOnStartup(options: StartupRecoveryOptions = {}): Promise<Task[]> {
    const allTasks = await this.store.list({ status: 'running', type: options.type });
    if (allTasks.length === 0) {
      return [];
    }

    const recoveredList: Task[] = [];
    for (const task of allTasks) {
      await withTaskUpdateLock(this.store, task.id, async () => {
        // list 只是候选快照；排队期间任务可能已取消、删除或完成，必须重读并校验。
        const current = await this.store.get(task.id);
        if (!current || current.status !== 'running') return;
        const recovered = recoverTaskAfterRestart(current, options);
        await this.store.save(recovered);
        this.notify('updated', recovered, current.status);
        recoveredList.push(cloneTask(recovered));
      });
    }

    return recoveredList;
  }

  /**
   * 删除任务（从持久化存储中移除）
   */
  public async remove(id: string): Promise<boolean> {
    return withTaskUpdateLock(this.store, id, async () => {
      const existing = await this.store.get(id);
      if (!existing) {
        return false;
      }

      const success = await this.store.delete(id);
      if (success) {
        this.notify('removed', existing);
      }
      return success;
    });
  }
}
