/**
 * Task 核心模块自检与单元测试
 *
 * 覆盖：
 * 1. pending -> running -> paused -> running -> completed 全流程
 * 2. 取消状态流转 (cancelled)
 * 3. 失败状态流转 (failed)
 * 4. 非法状态迁移阻断与异常抛出
 * 5. MV3 Service Worker 重启后孤儿任务恢复策略 (paused / failed)
 * 6. 事件订阅通知与快照防篡改隔离
 * 7. KeyValueStorageAdapter 适配器存储机制与 Chrome 适配器安全检测
 *
 * 运行方式（零第三方依赖，Node 内置支持）：
 *   node --test extensions/FishOps-Workbench/shared/task/task.test.ts
 * 或直接通过自检入口：
 *   node extensions/FishOps-Workbench/shared/task/task.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canTransition,
  InvalidTaskTransitionError,
  recoverTaskAfterRestart,
} from './task-machine.ts';
import {
  AdapterTaskStore,
  ChromeStorageSessionAdapter,
  MemoryStorageAdapter,
  MemoryTaskStore,
  ChromeStorageLocalAdapter,
} from './task-store.ts';
import { TaskManager } from './task-manager.ts';
import type { TaskChangeEvent } from '../types/task.ts';

test('生命周期测试: pending -> running -> paused -> running -> completed', async () => {
  const store = new MemoryTaskStore();
  const manager = new TaskManager({ store });

  // 1. 创建任务
  const task = await manager.create({
    type: 'capture',
    payload: { keyword: '钓鱼竿', limit: 20 },
  });
  assert.equal(task.status, 'pending');
  assert.equal(task.progress, 0);
  assert.equal(task.type, 'capture');
  assert.ok(task.createdAt > 0);
  assert.equal(task.startedAt, undefined);

  // 2. 启动任务
  const started = await manager.start(task.id);
  assert.equal(started.status, 'running');
  assert.ok(started.startedAt !== undefined && started.startedAt >= started.createdAt);

  // 3. 更新进度
  const progressed = await manager.updateProgress(task.id, 45, { currentStep: 'fetching_page_1' });
  assert.equal(progressed.progress, 45);
  assert.equal(progressed.meta?.currentStep, 'fetching_page_1');

  // 4. 暂停任务
  const paused = await manager.pause(task.id, '网络波动暂停');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.progress, 45);
  assert.equal(paused.meta?.pauseReason, '网络波动暂停');

  // 5. 恢复运行
  const resumed = await manager.resume(task.id);
  assert.equal(resumed.status, 'running');

  // 6. 成功完成
  const completed = await manager.complete(task.id, { totalCaptured: 20 });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.progress, 100);
  assert.ok(completed.endedAt !== undefined && completed.endedAt >= completed.startedAt!);
  assert.deepEqual(completed.result, { totalCaptured: 20 });

  // 校验存储中最终状态
  const persisted = await manager.getById(task.id);
  assert.ok(persisted !== null);
  assert.equal(persisted.status, 'completed');
  assert.equal(persisted.progress, 100);
});

test('取消流转测试: pending / running / paused -> cancelled', async () => {
  const manager = new TaskManager({ store: new MemoryTaskStore() });

  // pending -> cancelled
  const t1 = await manager.create({ type: 'publish', payload: { title: '闲置鱼线' } });
  const c1 = await manager.cancel(t1.id, '用户主动放弃');
  assert.equal(c1.status, 'cancelled');
  assert.equal(c1.error, '用户主动放弃');
  assert.ok(c1.endedAt !== undefined);

  // running -> cancelled
  const t2 = await manager.create({ type: 'publish', payload: { title: '鱼轮' } });
  await manager.start(t2.id);
  const c2 = await manager.cancel(t2.id, '超时取消');
  assert.equal(c2.status, 'cancelled');

  // paused -> cancelled
  const t3 = await manager.create({ type: 'publish', payload: { title: '鱼饵' } });
  await manager.start(t3.id);
  await manager.pause(t3.id);
  const c3 = await manager.cancel(t3.id, '不再需要');
  assert.equal(c3.status, 'cancelled');
});

test('失败流转测试: running / paused -> failed', async () => {
  const manager = new TaskManager({ store: new MemoryTaskStore() });

  // running -> failed
  const t1 = await manager.create({ type: 'analysis', payload: { shopId: 'shop_001' } });
  await manager.start(t1.id);
  const f1 = await manager.fail(t1.id, 'MTOP 签名解析失败');
  assert.equal(f1.status, 'failed');
  assert.equal(f1.error, 'MTOP 签名解析失败');
  assert.ok(f1.endedAt !== undefined);

  // paused -> failed
  const t2 = await manager.create({ type: 'analysis', payload: { shopId: 'shop_002' } });
  await manager.start(t2.id);
  await manager.pause(t2.id);
  const f2 = await manager.fail(t2.id, '会话 token 已过期');
  assert.equal(f2.status, 'failed');
  assert.equal(f2.error, '会话 token 已过期');
});

test('非法状态迁移校验与防御', async () => {
  const manager = new TaskManager({ store: new MemoryTaskStore() });

  const task = await manager.create({ type: 'capture', payload: {} });

  // 1. pending 不能直接 completed
  assert.equal(canTransition('pending', 'completed'), false);
  await assert.rejects(
    () => manager.complete(task.id),
    (err: unknown) => {
      assert.ok(err instanceof InvalidTaskTransitionError);
      assert.equal((err as InvalidTaskTransitionError).fromStatus, 'pending');
      assert.equal((err as InvalidTaskTransitionError).toStatus, 'completed');
      return true;
    },
  );

  // 2. pending 不能直接 paused
  assert.equal(canTransition('pending', 'paused'), false);
  await assert.rejects(() => manager.pause(task.id), InvalidTaskTransitionError);

  // 3. 终态不可逆: completed -> running / failed / cancelled
  await manager.start(task.id);
  await manager.complete(task.id);

  assert.equal(canTransition('completed', 'running'), false);
  await assert.rejects(() => manager.start(task.id), InvalidTaskTransitionError);
  await assert.rejects(() => manager.resume(task.id), InvalidTaskTransitionError);
  await assert.rejects(() => manager.fail(task.id, 'err'), InvalidTaskTransitionError);
  await assert.rejects(() => manager.cancel(task.id), InvalidTaskTransitionError);
});

test('Service Worker 重启恢复策略测试', async () => {
  const store = new MemoryTaskStore();
  const manager = new TaskManager({ store });

  // 准备任务数据
  const tRunning = await manager.create({ type: 'capture', payload: { count: 100 } });
  await manager.start(tRunning.id);
  await manager.updateProgress(tRunning.id, 60);

  const tPending = await manager.create({ type: 'publish', payload: {} });
  const tCompleted = await manager.create({ type: 'analysis', payload: {} });
  await manager.start(tCompleted.id);
  await manager.complete(tCompleted.id);

  // 场景 A: 默认 'paused' 恢复策略（保留进度，安全断点续跑）
  const recoveredA = await manager.recoverOnStartup({ strategy: 'paused' });
  assert.equal(recoveredA.length, 1);
  assert.equal(recoveredA[0].id, tRunning.id);
  assert.equal(recoveredA[0].status, 'paused');
  assert.equal(recoveredA[0].progress, 60);
  assert.ok(recoveredA[0].meta?.recoveryNote?.includes('自动挂起为 paused'));

  // 确认 pending 和 completed 任务未受影响
  const pCheck = await manager.getById(tPending.id);
  const cCheck = await manager.getById(tCompleted.id);
  assert.equal(pCheck?.status, 'pending');
  assert.equal(cCheck?.status, 'completed');

  // 场景 B: 'failed' 恢复策略（不可重入/非幂等任务）
  await manager.resume(tRunning.id); // paused -> running
  const recoveredB = await manager.recoverOnStartup({
    strategy: 'failed',
    reason: '原子发布不可重试，已中断标记失败',
  });
  assert.equal(recoveredB.length, 1);
  assert.equal(recoveredB[0].status, 'failed');
  assert.equal(recoveredB[0].error, '原子发布不可重试，已中断标记失败');

  // 测试单任务工具函数 recoverTaskAfterRestart 对非 running 状态的无害返回
  const idleTask = await manager.getById(tPending.id);
  assert.ok(idleTask);
  const noop = recoverTaskAfterRestart(idleTask);
  assert.equal(noop.status, 'pending');
});

test('事件订阅与快照不可变保护', async () => {
  const manager = new TaskManager({ store: new MemoryTaskStore() });
  const events: TaskChangeEvent[] = [];

  const unsubscribe = manager.subscribe((event) => {
    events.push(event);
  });

  const task = await manager.create({ type: 'capture', payload: { seed: 1 } });
  await manager.start(task.id);
  await manager.updateProgress(task.id, 30);
  await manager.complete(task.id);

  assert.equal(events.length, 4);
  assert.equal(events[0].eventType, 'created');
  assert.equal(events[1].eventType, 'updated');
  assert.equal(events[1].task.status, 'running');
  assert.equal(events[2].task.progress, 30);
  assert.equal(events[3].task.status, 'completed');

  // 快照防篡改校验：外部修改监听回调得到的 task 对象，不应污染底层存储
  const latestEventTask = events[3].task;
  (latestEventTask as any).progress = 999;
  latestEventTask.status = 'pending';

  const persisted = await manager.getById(task.id);
  assert.equal(persisted?.progress, 100);
  assert.equal(persisted?.status, 'completed');

  // 取消订阅测试
  unsubscribe();
  await manager.create({ type: 'publish', payload: {} });
  assert.equal(events.length, 4); // 数量不再增加
});

test('AdapterTaskStore 并发写入保持索引一致并按实体键自愈', async () => {
  const adapter = new MemoryStorageAdapter();
  const store = new AdapterTaskStore(adapter, 'concurrent');
  const makeTask = (id: string) => ({
    id, type: 'capture' as const, status: 'pending' as const, progress: 0,
    createdAt: Number(id), updatedAt: Number(id), payload: {},
  });

  await Promise.all([store.save(makeTask('1')), store.save(makeTask('2'))]);
  assert.deepEqual((await adapter.getItem<string[]>('concurrent:task_index'))?.slice().sort(), ['1', '2']);
  assert.ok(await adapter.getItem('concurrent:task:1'));
  assert.ok(await adapter.getItem('concurrent:task:2'));
  assert.deepEqual((await store.list()).map((task) => task.id).sort(), ['1', '2']);

  await Promise.all([
    store.saveBatch([makeTask('3'), makeTask('4')]),
    store.delete('1'),
    store.save(makeTask('5')),
  ]);
  assert.deepEqual(new Set(await adapter.getItem<string[]>('concurrent:task_index')), new Set(['2', '3', '4', '5']));
  for (const id of ['2', '3', '4', '5']) assert.ok(await adapter.getItem(`concurrent:task:${id}`));
  assert.equal(await adapter.getItem('concurrent:task:1'), null);
  assert.deepEqual(new Set((await store.list()).map((task) => task.id)), new Set(['2', '3', '4', '5']));

  await adapter.setItem('concurrent:task:orphan', makeTask('orphan'));
  assert.deepEqual((await store.list()).map((task) => task.id).sort(), ['2', '3', '4', '5', 'orphan']);
});

test('AdapterTaskStore 的同 StorageArea 多实例共用索引协调且错误后队列可继续', async () => {
  const data = new Map<string, unknown>();
  const area = {
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      if (keys === null || keys === undefined) return Object.fromEntries(data);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(list.filter((key) => data.has(key)).map((key) => [key, data.get(key)]));
    },
    async set(items: Record<string, unknown>) { for (const [key, value] of Object.entries(items)) data.set(key, value); },
    async remove(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key); },
  };
  const first = new AdapterTaskStore(new ChromeStorageLocalAdapter(area), 'shared');
  const second = new AdapterTaskStore(new ChromeStorageLocalAdapter(area), 'shared');
  const makeTask = (id: string) => ({
    id, type: 'capture' as const, status: 'pending' as const, progress: 0,
    createdAt: Number(id), updatedAt: Number(id), payload: {},
  });
  await Promise.all([first.save(makeTask('1')), second.save(makeTask('2'))]);
  assert.deepEqual(new Set(data.get('shared:task_index') as string[]), new Set(['1', '2']));
  assert.ok(data.has('shared:task:1'));
  assert.ok(data.has('shared:task:2'));
  assert.deepEqual((await first.list()).map((task) => task.id).sort(), ['1', '2']);
  const isolated = new AdapterTaskStore(new MemoryStorageAdapter(), 'shared');
  await isolated.save(makeTask('9'));
  assert.deepEqual((await isolated.list()).map((task) => task.id), ['9']);
  const otherPrefix = new AdapterTaskStore(new ChromeStorageLocalAdapter(area), 'other');
  await otherPrefix.save(makeTask('10'));
  assert.deepEqual((await first.list()).map((task) => task.id).sort(), ['1', '2']);

  let indexWrites = 0;
  const orderedAdapter = new MemoryStorageAdapter();
  const orderedSetItem = orderedAdapter.setItem.bind(orderedAdapter);
  orderedAdapter.setItem = async (key, value) => {
    if (key === 'ordered:task_index') indexWrites++;
    await orderedSetItem(key, value);
  };
  const ordered = new AdapterTaskStore(orderedAdapter, 'ordered');
  await ordered.saveBatch([makeTask('6'), makeTask('7'), makeTask('6')]);
  assert.deepEqual((await ordered.list()).map((task) => task.id), ['7', '6']);
  const indexWritesAfterInsert = indexWrites;
  await ordered.save(makeTask('6'));
  assert.equal(indexWrites, indexWritesAfterInsert);
  await Promise.all([ordered.clear(), ordered.save(makeTask('8'))]);
  assert.deepEqual((await ordered.list()).map((task) => task.id), ['8']);

  await ordered.save(makeTask('11'));
  await ordered.clear();
  assert.equal(await orderedAdapter.getItem('ordered:task:11'), null);
  await orderedAdapter.setItem('ordered:task:orphan', makeTask('orphan'));
  await orderedAdapter.setItem('other:task:keep', makeTask('keep'));
  await orderedAdapter.setItem('ordered:unrelated', 'keep');
  await ordered.clear();
  assert.equal(await orderedAdapter.getItem('ordered:task:orphan'), null);
  assert.ok(await orderedAdapter.getItem('other:task:keep'));
  assert.equal(await orderedAdapter.getItem('ordered:unrelated'), 'keep');

  const sameAdapterFirst = new AdapterTaskStore(orderedAdapter, 'multi');
  const sameAdapterSecond = new AdapterTaskStore(orderedAdapter, 'multi');
  await Promise.all([sameAdapterFirst.save(makeTask('12')), sameAdapterSecond.save(makeTask('13'))]);
  assert.deepEqual(new Set(await orderedAdapter.getItem<string[]>('multi:task_index')), new Set(['12', '13']));

  await sameAdapterFirst.delete('12');
  await sameAdapterSecond.save(makeTask('12'));
  assert.deepEqual(await orderedAdapter.getItem<string[]>('multi:task_index'), ['13', '12']);
  await Promise.all([sameAdapterFirst.save(makeTask('14')), sameAdapterSecond.delete('14')]);
  assert.deepEqual(await orderedAdapter.getItem<string[]>('multi:task_index'), ['13', '12']);
  assert.equal(await orderedAdapter.getItem('multi:task:14'), null);

  const sessionStoreA = new AdapterTaskStore(new ChromeStorageSessionAdapter(area), 'session');
  const sessionStoreB = new AdapterTaskStore(new ChromeStorageSessionAdapter(area), 'session');
  await Promise.all([sessionStoreA.save(makeTask('15')), sessionStoreB.save(makeTask('16'))]);
  assert.deepEqual(new Set(data.get('session:task_index') as string[]), new Set(['15', '16']));

  const failing = new MemoryStorageAdapter();
  const originalSet = failing.setItem.bind(failing);
  let shouldFail = true;
  failing.setItem = async (key, value) => {
    if (key === 'failure:task_index' && shouldFail) { shouldFail = false; throw new Error('index failed'); }
    await originalSet(key, value);
  };
  const store = new AdapterTaskStore(failing, 'failure');
  await assert.rejects(store.save(makeTask('3')), /index failed/);
  await store.save(makeTask('4'));
  assert.deepEqual((await store.list()).map((task) => task.id).sort(), ['3', '4']);
});

test('AdapterTaskStore 在调用时捕获 save 与 saveBatch 输入快照', async () => {
  const adapter = new MemoryStorageAdapter();
  const store = new AdapterTaskStore(adapter, 'snapshot');
  const task = { id: '1', type: 'capture' as const, status: 'pending' as const, progress: 0, createdAt: 1, updatedAt: 1, payload: { value: 'before' } };
  const savePromise = store.save(task);
  task.payload.value = 'after';
  task.id = 'changed';
  await savePromise;
  assert.equal((await store.get('1'))?.payload.value, 'before');
  assert.equal(await store.get('changed'), null);
  assert.deepEqual(await adapter.getItem('snapshot:task_index'), ['1']);

  const batchTask = { ...task, id: '2', payload: { value: 'before' } };
  const batchPromise = store.saveBatch([batchTask]);
  batchTask.payload.value = 'after';
  await batchPromise;
  assert.equal((await store.get('2'))?.payload.value, 'before');
});

test('持久化适配器 AdapterTaskStore 与 ChromeStorageSessionAdapter 隔离检测', async () => {
  // 1. 基于 MemoryStorageAdapter 的 AdapterTaskStore 校验
  const adapter = new MemoryStorageAdapter();
  const adapterStore = new AdapterTaskStore(adapter, 'test_app');
  const manager = new TaskManager({ store: adapterStore });

  const t1 = await manager.create({ type: 'capture', payload: { url: 'https://item.taobao.com' } });
  await manager.start(t1.id);
  await manager.updateProgress(t1.id, 80);

  const t2 = await manager.create({ type: 'publish', payload: { item: 'fish' } });

  // 验证列表按条件查询
  const runningList = await manager.list({ status: 'running' });
  assert.equal(runningList.length, 1);
  assert.equal(runningList[0].id, t1.id);

  const allList = await manager.list();
  assert.equal(allList.length, 2);

  // 2. 模拟 ChromeStorageArea 注入，验证 ChromeStorageSessionAdapter 读写与兼容性
  const mockStorageData = new Map<string, unknown>();
  const mockStorageArea = {
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      const result: Record<string, unknown> = {};
      if (!keys) {
        for (const [k, v] of mockStorageData.entries()) {
          result[k] = v;
        }
      } else if (typeof keys === 'string') {
        if (mockStorageData.has(keys)) {
          result[keys] = mockStorageData.get(keys);
        }
      } else if (Array.isArray(keys)) {
        for (const k of keys) {
          if (mockStorageData.has(k)) {
            result[k] = mockStorageData.get(k);
          }
        }
      }
      return result;
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) {
        mockStorageData.set(k, v);
      }
    },
    async remove(keys: string | string[]) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) {
        mockStorageData.delete(k);
      }
    },
  };

  const chromeAdapter = new ChromeStorageSessionAdapter(mockStorageArea);
  const chromeStore = new AdapterTaskStore(chromeAdapter, 'chrome_test');
  const chromeManager = new TaskManager({ store: chromeStore });

  const ct = await chromeManager.create({ type: 'analysis', payload: { tag: 'session_test' } });
  assert.equal(ct.status, 'pending');

  const loaded = await chromeManager.getById(ct.id);
  assert.ok(loaded !== null);
  assert.equal(loaded.id, ct.id);

  // 验证在当前无原生 chrome 环境下的静态支持探测为 false（安全不崩溃）
  assert.equal(ChromeStorageSessionAdapter.isSupported(), false);
});

/**
 * 独立执行入口：如果通过 `node task.test.ts` 直接运行，输出通过信息
 */
async function runSelfTest() {
  console.log('--- 开始运行 Task 模块自检测试 ---');
  // 当通过 node 直接执行时，node:test 会自动调度或输出
}

runSelfTest().catch((err) => {
  console.error('自检执行异常:', err);
  process.exit(1);
});
