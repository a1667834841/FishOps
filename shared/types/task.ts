/**
 * 任务模型与核心类型定义
 *
 * 遵循 FishOps Workbench 规划，支持 capture / publish / analysis 任务，
 * 并通过 TypeScript 声明合并 (Declaration Merging) 机制支持安全类型扩展，杜绝放宽为任意 string。
 */

/**
 * 任务状态流转枚举
 * - pending: 已创建待调度
 * - running: 正在执行中
 * - paused: 已挂起/暂停执行（支持断点续跑）
 * - completed: 执行成功（终态）
 * - failed: 执行失败（终态）
 * - cancelled: 已取消（终态）
 */
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * 任务通用元数据结构
 */
export interface TaskMeta {
  /** 重试次数 */
  retryCount?: number;
  /** 最大允许重试次数 */
  maxRetries?: number;
  /** 任务优先级，数值越大优先级越高 */
  priority?: number;
  /** 业务标签 */
  tags?: string[];
  /** 服务重启恢复策略标记或恢复备注 */
  recoveryNote?: string;
  /** 预留自定义字段 */
  [key: string]: unknown;
}

/**
 * 默认任务输入荷载结构（宽松安全对象）
 */
export type TaskPayload = Record<string, unknown>;

/**
 * 默认任务执行结果结构
 */
export type TaskResult = Record<string, unknown>;

/**
 * 任务类型定义注册表。
 * 内置支持 capture (采集)、publish (发布)、analysis (分析)。
 * 后续业务模块若需扩展类型，可通过 interface declaration merging 扩展本注册表，
 * 既保证静态强类型校验，又避免退化为任意 string。
 *
 * @example
 * declare module './task' {
 *   interface TaskTypeRegistry {
 *     sync: { payload: { target: string }; result: { count: number } };
 *   }
 * }
 */
export interface TaskTypeRegistry {
  capture: { payload: TaskPayload; result: TaskResult };
  publish: { payload: TaskPayload; result: TaskResult };
  analysis: { payload: TaskPayload; result: TaskResult };
}

/**
 * 严格受限的任务类型，取自 TaskTypeRegistry 的所有键名
 */
export type TaskType = keyof TaskTypeRegistry;

/**
 * 任务核心实体接口
 */
export interface Task<
  TType extends TaskType = TaskType,
  TPayload = TaskTypeRegistry[TType]['payload'],
  TResult = TaskTypeRegistry[TType]['result'],
  TMeta extends TaskMeta = TaskMeta,
  TStatus extends string = TaskStatus,
> {
  /** 全局唯一任务 ID */
  id: string;
  /** 任务类型（强约束） */
  type: TType;
  /** 任务当前流转状态 */
  status: TStatus;
  /** 任务进度（0 ~ 100） */
  progress: number;
  /** 创建时间戳（毫秒） */
  createdAt: number;
  /** 最后一次更新时间戳（毫秒） */
  updatedAt: number;
  /** 任务首次进入 running 状态的时间戳（毫秒） */
  startedAt?: number;
  /** 任务进入终态 (completed / failed / cancelled) 的结束时间戳（毫秒） */
  endedAt?: number;
  /** 任务执行入参 */
  payload: TPayload;
  /** 任务成功输出 */
  result?: TResult;
  /** 失败原因或错误信息 */
  error?: string;
  /** 任务扩展元数据 */
  meta?: TMeta;
}

/**
 * 创建任务时的入参定义
 */
export interface CreateTaskInput<
  TType extends TaskType = TaskType,
  TPayload = TaskTypeRegistry[TType]['payload'],
  TMeta extends TaskMeta = TaskMeta,
> {
  /** 可选自定义 ID，缺省时由 Manager 自动生成 UUID/纳秒唯一 ID */
  id?: string;
  /** 任务类型 */
  type: TType;
  /** 任务输入荷载 */
  payload: TPayload;
  /** 初始元数据 */
  meta?: TMeta;
}

/**
 * 任务查询过滤条件
 */
export interface TaskFilter {
  /** 按单个或多个状态筛选 */
  status?: string | string[];
  /** 按单个或多个任务类型筛选 */
  type?: TaskType | TaskType[];
  /** 最早创建时间 */
  createdAfter?: number;
  /** 最晚创建时间 */
  createdBefore?: number;
}

/**
 * 任务变更事件类型
 */
export type TaskEventType = 'created' | 'updated' | 'removed';

/**
 * 任务变更事件通知结构
 */
export interface TaskChangeEvent<TStatus extends string = TaskStatus> {
  /** 事件类型 */
  eventType: TaskEventType;
  /** 变更后的任务快照（如果是 removed 则为被删除前的数据） */
  task: Task<any, any, any, any, any>;
  /** 前一个状态（状态未变更时可选） */
  previousStatus?: TStatus;
  /** 发生时间戳 */
  timestamp: number;
}

/**
 * 任务变更订阅监听函数
 */
export type TaskChangeListener = (event: TaskChangeEvent) => void;
