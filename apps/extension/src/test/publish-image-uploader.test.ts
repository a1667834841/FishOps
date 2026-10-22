import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPublishImageUploader, type PublishImageUploadDeps } from '../publish-image-uploader.ts'

type Call = { url: string; init?: { signal?: unknown; credentials?: 'include' } }

type ScheduledTimer = { id: number; ms: number; fire: () => void }

/** 可控定时器：只登记回调与延时，不真正计时；由用例显式触发超时。 */
function fakeTimers() {
  const scheduled: ScheduledTimer[] = []
  const cleared: unknown[] = []
  let nextId = 1
  return {
    scheduled,
    cleared,
    setTimeout: (callback: () => void, ms: number) => {
      const timer: ScheduledTimer = { id: nextId++, ms, fire: callback }
      scheduled.push(timer)
      return timer.id
    },
    clearTimeout: (timer: unknown) => { cleared.push(timer) },
  }
}

/** 等待条件成立；只推进真实事件循环，不模拟时间。 */
async function waitUntil(predicate: () => boolean, label: string) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(predicate(), `等待条件超时：${label}`)
}

function fixture(overrides: Partial<PublishImageUploadDeps> = {}) {
  const calls: Call[] = []
  const uploads: Array<{ blob: unknown; filename: string }> = []
  const deps: PublishImageUploadDeps = {
    fetch: async (url, init) => {
      calls.push({ url, ...(init ? { init } : {}) })
      return { ok: true, status: 200, blob: async () => ({ size: 1024, type: 'image/jpeg' }) }
    },
    readBlob: async () => ({ size: 1024, type: 'image/jpeg' }),
    measure: async () => ({ width: 800, height: 600 }),
    upload: async (blob, filename) => {
      uploads.push({ blob, filename })
      return { url: 'https://upload.example.com/1.jpg', width: 800, height: 600 }
    },
    ...overrides,
  }
  return { uploader: createPublishImageUploader(deps), calls, uploads }
}

test('从 HTTPS 下载后上传，返回真实尺寸而不透传其他字段', async () => {
  const f = fixture()
  const result = await f.uploader.upload({ kind: 'url', url: 'https://img.example.com/source.jpg' })
  assert.deepEqual(result, {
    url: 'https://upload.example.com/1.jpg',
    widthSize: 800,
    heightSize: 600,
  })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0]?.url, 'https://img.example.com/source.jpg')
  assert.equal(f.calls[0]?.init?.credentials, 'include')
  assert.equal(f.uploads[0]?.filename, 'upload.jpg')
})

test('拒绝 HTTP 与无效 URL，不发下载请求', async () => {
  for (const url of ['http://img.example.com/a.jpg', 'not-a-url', 'blob:https://example.com/a']) {
    const f = fixture()
    await assert.rejects(f.uploader.upload({ kind: 'url', url }))
    assert.equal(f.calls.length, 0)
  }
})

test('非 2xx、超限、非图片、尺寸缺失均失败关闭', async () => {
  await assert.rejects(fixture({
    fetch: async () => ({ ok: false, status: 500, blob: async () => ({}) }),
  }).uploader.upload({ kind: 'url', url: 'https://img.example.com/a.jpg' }))

  await assert.rejects(fixture({
    readBlob: async () => ({ size: 10 * 1024 * 1024 + 1, type: 'image/jpeg' }),
  }).uploader.upload({ kind: 'url', url: 'https://img.example.com/a.jpg' }))

  await assert.rejects(fixture({
    readBlob: async () => ({ size: 10, type: 'text/html' }),
  }).uploader.upload({ kind: 'url', url: 'https://img.example.com/a.jpg' }))

  await assert.rejects(fixture({
    measure: async () => null,
  }).uploader.upload({ kind: 'url', url: 'https://img.example.com/a.jpg' }))
})

test('上传响应缺少 HTTPS URL 时失败关闭', async () => {
  await assert.rejects(fixture({
    upload: async () => ({ url: 'http://upload.example.com/1.jpg', width: 1, height: 1 }),
  }).uploader.upload({ kind: 'url', url: 'https://img.example.com/a.jpg' }))

  await assert.rejects(fixture({
    upload: async () => null,
  }).uploader.upload({ kind: 'url', url: 'https://img.example.com/a.jpg' }))

  await assert.rejects(fixture({
    upload: async () => 'https://upload.example.com/1.jpg',
  }).uploader.upload({ kind: 'url', url: 'https://img.example.com/a.jpg' }))
})

test('下载阶段 blob 永不完成时按下载超时失败，不重试且清理计时器', async () => {
  const timers = fakeTimers()
  let fetchCalls = 0
  let blobCalls = 0
  const f = fixture({
    fetch: async () => {
      fetchCalls++
      return {
        ok: true,
        status: 200,
        blob: () => {
          blobCalls++
          return new Promise(() => {})
        },
      }
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  })

  const pending = f.uploader.upload({ kind: 'url', url: 'https://img.example.com/a.jpg' })
  assert.equal(timers.scheduled.length, 1)
  await waitUntil(() => blobCalls > 0, 'blob 已进入永不完成的等待')

  timers.scheduled[0]?.fire()
  await assert.rejects(pending, /图片下载超时/)

  assert.equal(fetchCalls, 1)
  assert.equal(blobCalls, 1)
  assert.equal(timers.scheduled.length, 1)
  assert.deepEqual(timers.cleared, [timers.scheduled[0]?.id])
})

test('measure 永不完成时按上传超时失败，不重试且清理计时器', async () => {
  const timers = fakeTimers()
  let measureCalls = 0
  const f = fixture({
    measure: () => {
      measureCalls++
      return new Promise(() => {})
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  })

  const pending = f.uploader.upload({ kind: 'url', url: 'https://img.example.com/a.jpg' })
  await waitUntil(() => measureCalls > 0, 'measure 已进入永不完成的等待')
  assert.equal(timers.scheduled.length, 2)

  timers.scheduled[1]?.fire()
  await assert.rejects(pending, /图片上传超时/)

  assert.equal(f.calls.length, 1)
  assert.equal(f.uploads.length, 1)
  assert.equal(measureCalls, 1)
  assert.equal(timers.scheduled.length, 2)
  assert.deepEqual(timers.cleared, [timers.scheduled[0]?.id, timers.scheduled[1]?.id])
})

test('上传响应缺少宽高但真实解码有尺寸时正常输出', async () => {
  const f = fixture({
    upload: async () => ({ url: 'https://upload.example.com/2.jpg', success: true, object: { url: 'ignored' } }),
    measure: async () => ({ width: 1024, height: 768 }),
  })
  assert.deepEqual(await f.uploader.upload({ kind: 'url', url: 'https://img.example.com/a.jpg' }), {
    url: 'https://upload.example.com/2.jpg',
    widthSize: 1024,
    heightSize: 768,
  })
})

test('平台响应宽高与 pix 与真实解码不一致时以真实解码尺寸为准', async () => {
  const f = fixture({
    upload: async () => ({ url: 'https://upload.example.com/3.jpg', width: 1, height: 1, pix: '1x1' }),
    measure: async () => ({ width: 1024, height: 768 }),
  })
  assert.deepEqual(await f.uploader.upload({ kind: 'url', url: 'https://img.example.com/a.jpg' }), {
    url: 'https://upload.example.com/3.jpg',
    widthSize: 1024,
    heightSize: 768,
  })
})
