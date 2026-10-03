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

/**
 * 通用底层键值存储适配器接口
 */
export interface KeyValueStorageAdapter {
  getItem<T = unknown>(key: string): Promise<T | null>;
  setItem<T = unknown>(key: string, value: T): Promise<void>;
  removeItem(key: string): Promise<void>;
  getKeys(): Promise<string[]>;
  clear(): Promise<void>;
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

/**
 * 基于底层 KeyValueStorageAdapter 构建的通用持久化 TaskStore。
 *
 * 采用独立 Key + 索引列表存储模式：
 * - 任务实体 Key 格式: `${prefix}:task:${taskId}`
 * - 任务 ID 索引列表 Key: `${prefix}:index`
 * 保证高效按 ID 单条读写，同时支持列表按条件索引过滤。
 */
export class AdapterTaskStore implements TaskStore {
  private readonly adapter: KeyValueStorageAdapter;
  private readonly prefix: string;
  private readonly indexKey: string;

  constructor(adapter: KeyValueStorageAdapter, prefix = 'fishops') {
    this.adapter = adapter;
    this.prefix = prefix;
    this.indexKey = `${prefix}:task_index`;
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
    const index = await this.getIndex();
    if (index.length === 0) return [];

    const tasks: Task[] = [];
    for (const id of index) {
      const task = await this.get(id);
      if (task && matchTaskFilter(task, filter)) {
        tasks.push(task);
      }
    }

    return tasks.sort((a, b) => b.createdAt - a.createdAt);
  }

  async save(task: Task): Promise<void> {
    const cloned = cloneTask(task);
    await this.adapter.setItem(this.getTaskKey(task.id), cloned);

    const index = await this.getIndex();
    if (!index.includes(task.id)) {
      index.push(task.id);
      await this.saveIndex(index);
    }
  }

  async saveBatch(tasks: Task[]): Promise<void> {
    if (tasks.length === 0) return;

    const index = await this.getIndex();
    const indexSet = new Set(index);

    for (const task of tasks) {
      const cloned = cloneTask(task);
      await this.adapter.setItem(this.getTaskKey(task.id), cloned);
      indexSet.add(task.id);
    }

    await this.saveIndex(Array.from(indexSet));
  }

  async delete(id: string): Promise<boolean> {
    const key = this.getTaskKey(id);
    const existing = await this.adapter.getItem(key);
    if (!existing) {
      return false;
    }

    await this.adapter.removeItem(key);
    const index = await this.getIndex();
    const filtered = index.filter((item) => item !== id);
    await this.saveIndex(filtered);
    return true;
  }

  async clear(): Promise<void> {
    const index = await this.getIndex();
    for (const id of index) {
      await this.adapter.removeItem(this.getTaskKey(id));
    }
    await this.adapter.removeItem(this.indexKey);
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
