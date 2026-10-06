/**
 * 任务持久化存储抽象与适配器实现
 *
 * MV3 Service Worker 生命周期短暂，任务状态不能只驻留于运行内存，
 * 必须通过 Storage 持久化（如 chrome.storage.session / chrome.storage.local 或 IndexedDB）。
 * 本模块提供可替换的 TaskStore 接口，包含内存实现、Chrome Session Storage 适配器
 * 与 Chrome Local Storage 适配器，并做好运行环境隔离，确保在 Node.js 单元测试和
 * 无 chrome 变量环境下正常导入。
 *
 * 关键区别（扩展 reload 语义）：
 * - chrome.storage.session 为内存态，官方语义是「扩展被 disabled / reloaded / updated
 *   或浏览器重启时清空」，因此不能承载需要跨 reload 保留的历史；
 * - chrome.storage.local 落盘持久化，仅在扩展被移除时清除，适合保存需要跨 reload
 *   保留的任务历史（如发布任务的 waiting_confirmation 断点）。
 */

import type { Task, TaskFilter } from '../types/task.ts';

/**
 * 任务深拷贝工具，阻断内部状态与外部修改的引用关联
 */
export function cloneTask<T extends Task>(task: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(task);
  }
  return JSON.parse(JSON.stringify(task)) as T;
}

/**
 * 任务持久化存储接口
 */
export interface TaskStore {
  /** 可选的共享命名空间身份；包装同一底层存储的实例必须返回同一对象。 */
  readonly updateCoordinationKey?: object;
  /** 根据任务 ID 查询任务，不存在返回 null */
  get(id: string): Promise<Task | null>;
  /** 查询符合条件的任务列表 */
  list(filter?: TaskFilter): Promise<Task[]>;
  /** 保存或更新单个任务 */
  save(task: Task): Promise<void>;
  /** 批量保存或更新任务 */
  saveBatch(tasks: Task[]): Promise<void>;
  /** 删除指定 ID 的任务，返回是否成功删除 */
  delete(id: string): Promise<boolean>;
  /** 清空存储中所有任务（主要用于测试或重置） */
  clear(): Promise<void>;
}

const taskUpdateQueues = new WeakMap<object, Map<string, Promise<void>>>();
const taskStoreNamespaces = new WeakMap<object, Map<string, object>>();

/** 在同一 realm 内按存储命名空间与任务 ID 串行执行完整读、校验、写入操作。 */
export function withTaskUpdateLock<T>(store: TaskStore, id: string, operation: () => Promise<T>): Promise<T> {
  const key = store.updateCoordinationKey ?? store;
  let queues = taskUpdateQueues.get(key);
  if (!queues) {
    queues = new Map();
    taskUpdateQueues.set(key, queues);
  }
  const result = (queues.get(id) ?? Promise.resolve()).then(operation);
  // 当前调用保留拒绝结果，队列尾部消费异常，避免一次失败阻断后续任务操作。
  const tail = result.then(() => undefined, () => undefined);
  queues.set(id, tail);
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return result;
}

/**
 * 通用底层键值存储适配器接口
 */
export interface KeyValueStorageAdapter {
  getItem<T = unknown>(key: string): Promise<T | null>;
  setItem<T = unknown>(key: string, value: T): Promise<void>;
  removeItem(key: string): Promise<void>;
  getKeys(): Promise<string[]>;
  clear(): Promise<void>;
  /** 可选的底层区域身份，用于同一 realm 内共享操作协调。 */
  readonly coordinationKey?: object;
}

/**
 * 通用任务过滤计算函数
 */
export function matchTaskFilter(task: Task, filter?: TaskFilter): boolean {
  if (!filter) return true;

  if (filter.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(task.status)) {
      return false;
    }
  }

  if (filter.type !== undefined) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!types.includes(task.type)) {
      return false;
    }
  }

  if (filter.createdAfter !== undefined && task.createdAt < filter.createdAfter) {
    return false;
  }

  if (filter.createdBefore !== undefined && task.createdAt > filter.createdBefore) {
    return false;
  }

  return true;
}

/**
 * 内存型 TaskStore 实现（开箱即用，用于 Node.js 单元测试及开发环境）
 */
export class MemoryTaskStore implements TaskStore {
  private readonly store = new Map<string, Task>();

  async get(id: string): Promise<Task | null> {
    const task = this.store.get(id);
    return task ? cloneTask(task) : null;
  }

  async list(filter?: TaskFilter): Promise<Task[]> {
    const results: Task[] = [];
    for (const task of this.store.values()) {
      if (matchTaskFilter(task, filter)) {
        results.push(cloneTask(task));
      }
    }
    // 默认按创建时间降序排序
    return results.sort((a, b) => b.createdAt - a.createdAt);
  }

  async save(task: Task): Promise<void> {
    this.store.set(task.id, cloneTask(task));
  }

  async saveBatch(tasks: Task[]): Promise<void> {
    for (const task of tasks) {
      this.store.set(task.id, cloneTask(task));
    }
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

/**
 * 内存型底层 KeyValueStorageAdapter
 */
export class MemoryStorageAdapter implements KeyValueStorageAdapter {
  private readonly memory = new Map<string, unknown>();

  async getItem<T = unknown>(key: string): Promise<T | null> {
    const val = this.memory.get(key);
    if (val === undefined) return null;
    return typeof structuredClone === 'function'
      ? structuredClone(val as T)
      : JSON.parse(JSON.stringify(val));
  }

  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    const cloned = typeof structuredClone === 'function'
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
    this.memory.set(key, cloned);
  }

  async removeItem(key: string): Promise<void> {
    this.memory.delete(key);
  }

  async getKeys(): Promise<string[]> {
    return Array.from(this.memory.keys());
  }

  async clear(): Promise<void> {
    this.memory.clear();
  }
}

/**
 * 兼容 Chrome StorageArea 的最小接口约束，避免直接依赖 chrome 类型包
 */
export interface MinimalChromeStorageArea {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear?(): Promise<void>;
}

/**
 * Chrome Storage Session 存储适配器
 *
 * 设计考量：
 * 1. 杜绝在模块顶级直接访问 `chrome.storage.session`，避免在 Node.js 测试环境加载时抛出 ReferenceError。
 * 2. 构造函数支持显式注入 storageArea，方便在测试中 mock。
 * 3. 缺省时运行时动态嗅探 globalThis.chrome.storage.session。
 */
export class ChromeStorageSessionAdapter implements KeyValueStorageAdapter {
  private readonly storageArea: MinimalChromeStorageArea;

  /** 返回底层区域身份，使包装同一 StorageArea 的适配器共享任务写队列。 */
  get coordinationKey(): object { return this.storageArea; }

  constructor(customStorageArea?: MinimalChromeStorageArea) {
    if (customStorageArea) {
      this.storageArea = customStorageArea;
      return;
    }

    const detected = ChromeStorageSessionAdapter.detectSessionStorage();
    if (!detected) {
      throw new Error(
        '[ChromeStorageSessionAdapter] 当前运行环境不支持 chrome.storage.session，请注入自定义 StorageArea 或在 Chrome Extension 环境下运行',
      );
    }
    this.storageArea = detected;
  }

  /**
   * 安全探测当前环境是否存在 chrome.storage.session
   */
  public static isSupported(): boolean {
    return this.detectSessionStorage() !== null;
  }

  private static detectSessionStorage(): MinimalChromeStorageArea | null {
    if (typeof globalThis === 'undefined') return null;
    const g = globalThis as { chrome?: { storage?: { session?: MinimalChromeStorageArea } } };
    return g.chrome?.storage?.session ?? null;
  }

  async getItem<T = unknown>(key: string): Promise<T | null> {
    const res = await this.storageArea.get(key);
    const value = res?.[key];
    return (value !== undefined ? (value as T) : null);
  }

  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    await this.storageArea.set({ [key]: value });
  }

  async removeItem(key: string): Promise<void> {
    await this.storageArea.remove(key);
  }

  async getKeys(): Promise<string[]> {
    const all = await this.storageArea.get(null);
    return Object.keys(all || {});
  }

  async clear(): Promise<void> {
    if (typeof this.storageArea.clear === 'function') {
      await this.storageArea.clear();
    } else {
      const keys = await this.getKeys();
      if (keys.length > 0) {
        await this.storageArea.remove(keys);
      }
    }
  }
}

/**
 * Chrome Storage Local 存储适配器
 *
 * 与 ChromeStorageSessionAdapter 的唯一差异是存储区域：
 * chrome.storage.local 会写入磁盘，扩展被 reload / 更新后仍然保留；
 * 而 chrome.storage.session 在扩展 reload / 更新 / 浏览器重启时会被清空。
 * 因此需要跨扩展 reload 保留的任务历史（如发布任务 waiting_confirmation 断点）
 * 必须使用 local，而不是 session。
 */
export class ChromeStorageLocalAdapter implements KeyValueStorageAdapter {
  private readonly storageArea: MinimalChromeStorageArea;

  /** 返回底层区域身份，使包装同一 StorageArea 的适配器共享任务写队列。 */
  get coordinationKey(): object { return this.storageArea; }

  constructor(customStorageArea?: MinimalChromeStorageArea) {
    if (customStorageArea) {
      this.storageArea = customStorageArea;
      return;
    }

    const detected = ChromeStorageLocalAdapter.detectLocalStorage();
    if (!detected) {
      throw new Error(
        '[ChromeStorageLocalAdapter] 当前运行环境不支持 chrome.storage.local，请注入自定义 StorageArea 或在 Chrome Extension 环境下运行',
      );
    }
    this.storageArea = detected;
  }

  /**
   * 安全探测当前环境是否存在 chrome.storage.local
   */
  public static isSupported(): boolean {
    return ChromeStorageLocalAdapter.detectLocalStorage() !== null;
  }

  private static detectLocalStorage(): MinimalChromeStorageArea | null {
    if (typeof globalThis === 'undefined') return null;
    const g = globalThis as { chrome?: { storage?: { local?: MinimalChromeStorageArea } } };
    return g.chrome?.storage?.local ?? null;
  }

  async getItem<T = unknown>(key: string): Promise<T | null> {
    const res = await this.storageArea.get(key);
    const value = res?.[key];
    return (value !== undefined ? (value as T) : null);
  }

  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    await this.storageArea.set({ [key]: value });
  }

  async removeItem(key: string): Promise<void> {
    await this.storageArea.remove(key);
  }

  async getKeys(): Promise<string[]> {
    const all = await this.storageArea.get(null);
    return Object.keys(all || {});
  }

  async clear(): Promise<void> {
    if (typeof this.storageArea.clear === 'function') {
      await this.storageArea.clear();
    } else {
      const keys = await this.getKeys();
      if (keys.length > 0) {
        await this.storageArea.remove(keys);
      }
    }
  }
}

const taskStoreQueues = new WeakMap<object, Map<string, Promise<void>>>();

/**
 * 基于底层 KeyValueStorageAdapter 构建的通用持久化 TaskStore。
 *
 * 采用独立 Key + 索引列表存储模式：
 * - 任务实体 Key 格式: `${prefix}:task:${taskId}`
 * - 任务 ID 索引列表 Key: `${prefix}:task_index`
 * 保证高效按 ID 单条读写，同时支持列表按条件索引过滤。
 */
export class AdapterTaskStore implements TaskStore {
  private readonly adapter: KeyValueStorageAdapter;
  private readonly prefix: string;
  private readonly indexKey: string;
  private readonly coordinationKey: object;
  /** 同一区域和前缀共用身份，单任务队列与索引写队列分离，避免重入死锁。 */
  public readonly updateCoordinationKey: object;

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    // 同一 realm 内相同存储区域和前缀共享互斥队列，避免索引读改写覆盖；
    // 队列尾部消费失败状态以便后续操作继续，当前操作仍保留原始拒绝结果。
    let queues = taskStoreQueues.get(this.coordinationKey);
    if (!queues) {
      queues = new Map();
      taskStoreQueues.set(this.coordinationKey, queues);
    }
    const previous = queues.get(this.prefix) ?? Promise.resolve();
    const result = previous.then(operation);
    queues.set(this.prefix, result.then(() => undefined, () => undefined));
    return result;
  }

  constructor(adapter: KeyValueStorageAdapter, prefix = 'fishops') {
    this.adapter = adapter;
    this.prefix = prefix;
    this.indexKey = `${prefix}:task_index`;
    this.coordinationKey = adapter.coordinationKey ?? adapter;
    let namespaces = taskStoreNamespaces.get(this.coordinationKey);
    if (!namespaces) {
      namespaces = new Map();
      taskStoreNamespaces.set(this.coordinationKey, namespaces);
    }
    let namespace = namespaces.get(prefix);
    if (!namespace) {
      namespace = {};
      namespaces.set(prefix, namespace);
    }
    this.updateCoordinationKey = namespace;
  }

  private getTaskKey(id: string): string {
    return `${this.prefix}:task:${id}`;
  }

  private async getIndex(): Promise<string[]> {
    const index = await this.adapter.getItem<string[]>(this.indexKey);
    return Array.isArray(index) ? index : [];
  }

  private async saveIndex(index: string[]): Promise<void> {
    await this.adapter.setItem(this.indexKey, Array.from(new Set(index)));
  }

  async get(id: string): Promise<Task | null> {
    const task = await this.adapter.getItem<Task>(this.getTaskKey(id));
    return task ? cloneTask(task) : null;
  }

  async list(filter?: TaskFilter): Promise<Task[]> {
    return this.enqueue(async () => {
      const index = await this.getIndex();
      const keys = await this.adapter.getKeys();
      const ids = Array.from(new Set([
        ...index,
        ...keys.filter((key) => key.startsWith(`${this.prefix}:task:`))
          .map((key) => key.slice(`${this.prefix}:task:`.length)),
      ]));
      const tasks: Task[] = [];
      const existingIds: string[] = [];
      for (const id of ids) {
        const task = await this.get(id);
        if (task) {
          existingIds.push(id);
          if (matchTaskFilter(task, filter)) tasks.push(task);
        }
      }
      if (existingIds.length !== index.length || existingIds.some((id, i) => id !== index[i])) {
        await this.saveIndex(existingIds);
      }
      return tasks.sort((a, b) => b.createdAt - a.createdAt);
    });
  }

  async save(task: Task): Promise<void> {
    const cloned = cloneTask(task);
    return this.enqueue(async () => {
      await this.adapter.setItem(this.getTaskKey(cloned.id), cloned);
      const index = await this.getIndex();
      if (!index.includes(cloned.id)) {
        index.push(cloned.id);
        await this.saveIndex(index);
      }
    });
  }

  async saveBatch(tasks: Task[]): Promise<void> {
    if (tasks.length === 0) return;
    const clonedTasks = tasks.map((task) => cloneTask(task));
    return this.enqueue(async () => {
      const indexSet = new Set(await this.getIndex());
      for (const task of clonedTasks) {
        await this.adapter.setItem(this.getTaskKey(task.id), task);
        indexSet.add(task.id);
      }
      await this.saveIndex(Array.from(indexSet));
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const key = this.getTaskKey(id);
      const existing = await this.adapter.getItem(key);
      if (!existing) return false;
      await this.adapter.removeItem(key);
      await this.saveIndex((await this.getIndex()).filter((item) => item !== id));
      return true;
    });
  }

  async clear(): Promise<void> {
    return this.enqueue(async () => {
      const prefix = `${this.prefix}:task:`;
      const keys = await this.adapter.getKeys();
      for (const key of keys) {
        if (key.startsWith(prefix)) await this.adapter.removeItem(key);
      }
      await this.adapter.removeItem(this.indexKey);
    });
  }
}

/**
 * 工厂函数：自动创建适宜当前运行环境的 TaskStore
 *
 * 若处于支持 chrome.storage.session 的扩展环境，自动返回 Chrome Storage 适配的存储；
 * 否则优雅回退到内存存储，保证单元测试和非扩展环境正常运行。
 */
export function createDefaultTaskStore(): TaskStore {
  if (ChromeStorageSessionAdapter.isSupported()) {
    return new AdapterTaskStore(new ChromeStorageSessionAdapter());
  }
  return new MemoryTaskStore();
}

/**
 * 工厂函数：创建基于 chrome.storage.local 的持久化 TaskStore。
 *
 * 与 createDefaultTaskStore（chrome.storage.session，扩展 reload 即清空）不同，
 * 该存储在扩展被 reload / 更新后依然保留，用于必须跨 reload 保留的任务历史
 * （如发布任务的 waiting_confirmation 断点，确保 reload 后仍可查询且不被自动重跑 / 提交）。
 * 无 chrome.storage.local 时优雅回退到内存存储，保证 Node 单元测试正常运行。
 *
 * @param prefix 存储键前缀，默认 'fishops'；可用独立前缀与其它任务存储隔离。
 */
export function createPersistentTaskStore(prefix = 'fishops'): TaskStore {
  if (ChromeStorageLocalAdapter.isSupported()) {
    return new AdapterTaskStore(new ChromeStorageLocalAdapter(), prefix);
  }
  return new MemoryTaskStore();
}
