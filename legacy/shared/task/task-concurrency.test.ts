import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskManager } from './task-manager.ts';
import { AdapterTaskStore, ChromeStorageSessionAdapter, MemoryStorageAdapter, MemoryTaskStore } from './task-store.ts';
import type { TaskStore } from './task-store.ts';

async function running(store: TaskStore = new MemoryTaskStore()) {
  const manager = new TaskManager({ store });
  const task = await manager.create({ type: 'capture', payload: {} });
  await manager.start(task.id);
  return { manager, other: new TaskManager({ store }), id: task.id, store };
}

for (const multiInstance of [false, true]) {
  test(`取消先入队后进度更新不得复活任务（多实例=${multiInstance}）`, async () => {
    const { manager, other, id } = await running();
    const results = await Promise.allSettled([
      manager.cancel(id, '用户取消'),
      (multiInstance ? other : manager).updateProgress(id, 50, { checkpoint: 1 }),
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    const final = await manager.getById(id);
    assert.equal(final?.status, 'cancelled');
    assert.equal(final?.error, '用户取消');
    assert.equal(final?.meta.cancelReason, '用户取消');
    assert.equal(final?.progress, 0);
  });
}

for (const state of ['paused', 'completed', 'failed', 'waiting_confirmation'] as const) {
  test(`${state} 与进度交错时保留最新状态与元数据`, async () => {
    const { manager, other, id } = await running();
    const transition = state === 'paused' ? manager.pause(id, '暂停原因')
      : state === 'completed' ? manager.complete(id, { ok: true })
      : state === 'failed' ? manager.fail(id, '失败原因')
      : manager.waitForConfirmation(id, { result: { ok: true }, meta: { confirmed: false } });
    const results = await Promise.allSettled([transition, other.updateProgress(id, 50, { checkpoint: 1 })]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, state === 'paused' ? 'fulfilled' : 'rejected');
    const final = await manager.getById(id);
    assert.equal(final?.status, state);
    if (state === 'paused') {
      assert.equal(final?.meta.pauseReason, '暂停原因');
      assert.equal(final?.meta.checkpoint, 1);
    }
    if (state === 'completed') {
      assert.deepEqual(final?.result, { ok: true });
      assert.equal(final?.progress, 100);
    }
    if (state === 'failed') assert.equal(final?.error, '失败原因');
    if (state === 'waiting_confirmation') assert.equal(final?.meta.confirmed, false);
  });
}

test('进度先入队后取消保留断点，非法更新后队列仍可执行', async () => {
  const { manager, other, id } = await running();
  await Promise.all([manager.updateProgress(id, 50, { checkpoint: 1 }), other.cancel(id, '取消')]);
  const final = await manager.getById(id);
  assert.equal(final?.status, 'cancelled');
  assert.equal(final?.progress, 50);
  assert.equal(final?.meta.checkpoint, 1);
  await assert.rejects(manager.start(id));
  assert.equal(await other.remove(id), true);
});

test('并发进度更新合并各自元数据，通知使用最新快照', async () => {
  const { manager, id } = await running();
  const checkpoints: unknown[] = [];
  manager.subscribe(event => checkpoints.push(event.task.meta));
  await Promise.all([manager.updateProgress(id, 10, { a: 1 }), manager.updateProgress(id, 20, { b: 2 })]);
  assert.deepEqual((await manager.getById(id))?.meta, { a: 1, b: 2 });
  assert.deepEqual(checkpoints, [{ a: 1 }, { a: 1, b: 2 }]);
});

test('不同 adapter 包装同一 Chrome 区域和前缀时共享单任务更新队列', async () => {
  const data: Record<string, unknown> = {};
  const area = {
    async get(key?: string | string[] | Record<string, unknown> | null) {
      return key == null ? structuredClone(data) : { [key as string]: structuredClone(data[key as string]) };
    },
    async set(values: Record<string, unknown>) { Object.assign(data, structuredClone(values)); },
    async remove(keys: string | string[]) { for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key]; },
  };
  const { manager, id } = await running(new AdapterTaskStore(new ChromeStorageSessionAdapter(area)));
  const other = new TaskManager({ store: new AdapterTaskStore(new ChromeStorageSessionAdapter(area)) });
  const results = await Promise.allSettled([manager.cancel(id, '取消'), other.updateProgress(id, 50)]);
  assert.equal(results[1].status, 'rejected');
  assert.equal((await other.getById(id))?.status, 'cancelled');
});

test('恢复必须重新读取任务，不覆盖扫描后发生的取消', async () => {
  class StaleListStore extends MemoryTaskStore {
    afterList?: () => Promise<unknown>;
    override async list(filter?: Parameters<TaskStore['list']>[0]) {
      const tasks = await super.list(filter);
      await this.afterList?.();
      return tasks;
    }
  }
  const store = new StaleListStore();
  const { manager, other, id } = await running(store);
  store.afterList = () => other.cancel(id, '取消');
  assert.deepEqual(await manager.recoverOnStartup(), []);
  assert.equal((await manager.getById(id))?.status, 'cancelled');
});

test('恢复与进度交错时保留恢复状态和原因', async () => {
  const { manager, other, id } = await running();
  await Promise.allSettled([manager.recoverOnStartup({ strategy: 'failed', reason: '重启' }), other.updateProgress(id, 50)]);
  const final = await manager.getById(id);
  assert.equal(final?.status, 'failed');
  assert.equal(final?.error, '重启');
});

test('同一 ID 并发创建只成功一次，删除不被旧更新复活', async () => {
  const store = new MemoryTaskStore();
  const manager = new TaskManager({ store });
  const other = new TaskManager({ store });
  const results = await Promise.allSettled([
    manager.create({ id: 'same', type: 'capture', payload: {} }),
    other.create({ id: 'same', type: 'capture', payload: {} }),
  ]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  await manager.start('same');
  const removal = await Promise.allSettled([manager.remove('same'), other.updateProgress('same', 50)]);
  assert.equal(removal[1].status, 'rejected');
  assert.equal(await manager.getById('same'), null);
});

test('不同任务、存储区域和前缀独立执行', { timeout: 5000 }, async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  class BlockingStore extends AdapterTaskStore {
    blockedId?: string;
    override async get(id: string) {
      if (id === this.blockedId) { entered(); await gate; }
      return super.get(id);
    }
  }
  const adapter = new MemoryStorageAdapter();
  const store = new BlockingStore(adapter, 'first');
  const { manager, id } = await running(store);
  const second = await manager.create({ type: 'capture', payload: {} });
  await manager.start(second.id);
  store.blockedId = id;
  const blocked = manager.updateProgress(id, 10);
  await started;
  try {
    await manager.updateProgress(second.id, 20);
    for (const independentStore of [new AdapterTaskStore(adapter, 'second'), new AdapterTaskStore(new MemoryStorageAdapter(), 'first')]) {
      const independent = new TaskManager({ store: independentStore });
      await independent.create({ id, type: 'capture', payload: {} });
      await independent.start(id);
      assert.equal((await independent.updateProgress(id, 30)).progress, 30);
    }
  } finally { release(); }
  await blocked;
});

for (const action of ['resume', 'requeue'] as const) {
  test(`${action} 与进度交错时校验最新状态`, async () => {
    const { manager, other, id } = await running();
    await manager.pause(id, '暂停');
    const results = await Promise.allSettled([manager[action](id), other.updateProgress(id, 40, { checkpoint: 1 })]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, action === 'resume' ? 'fulfilled' : 'rejected');
    assert.equal((await manager.getById(id))?.status, action === 'resume' ? 'running' : 'pending');
  });
}

test('底层写入失败不阻断后续同任务操作', async () => {
  class FailingStore extends MemoryTaskStore {
    failNext = false;
    override async save(task: Parameters<TaskStore['save']>[0]) {
      if (this.failNext) { this.failNext = false; throw new Error('模拟写入失败'); }
      await super.save(task);
    }
  }
  const store = new FailingStore();
  const { manager, other, id } = await running(store);
  store.failNext = true;
  const results = await Promise.allSettled([manager.pause(id), other.cancel(id, '取消')]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal((await manager.getById(id))?.status, 'cancelled');
});
