/**
 * 发布图片上传适配器（MAIN world）。
 *
 * 只接受 HTTPS 远程图片，经页面 fetch 下载并校验大小与 MIME，再提交到
 * 闲鱼官方上传域名。上传成功必须同时取得 HTTPS URL 和真实像素宽高；
 * 任一条件不成立都失败关闭，绝不伪造图片对象。
 */

import type { PublishImageUploader, PublishUploadedImage } from './publish-page-executor.ts'

export type PublishImageFetchResponse = {
  ok: boolean
  status: number
  blob(): Promise<unknown>
}

/** 页面 fetch 类型；page-entry 负责绑定到页面原生网络能力。 */
export type PublishImageFetch = (
  url: string,
  init?: { signal?: unknown; credentials?: 'include' },
) => Promise<PublishImageFetchResponse>

export type PublishImageUploadDeps = {
  /** 页面 fetch；下载失败不能返回占位图。 */
  fetch: PublishImageFetch
  /** 读取 Blob 的 size/type，并用真实解码结果取得宽高。 */
  readBlob: (blob: unknown) => Promise<{ size: number; type: string }>
  measure: (blob: unknown) => Promise<{ width: number; height: number } | null>
  upload: (blob: unknown, filename: string) => Promise<unknown>
  setTimeout?: (callback: () => void, ms: number) => unknown
  clearTimeout?: (timer: unknown) => void
  AbortController?: new () => { signal: unknown; abort(): void }
}

/** 生产上传函数；由 page-entry 注入页面 fetch，本模块不直接调用全局网络 API。 */
export type PublishImageUploadTransport = (
  url: string,
  init: { method: 'POST'; body: unknown; credentials: 'include'; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'])
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 30_000

/**
 * 上传结果只接受成功对象中的 HTTPS URL；宽高与 pix 等字段不进入公共结果。
 *
 * 平台响应是否携带 width/height/pix 不固定，且这些字段未经解码验证，
 * 因此不要求也不采信，真实像素宽高一律由页面解码取得。
 */
function uploadedUrl(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('上传响应结构无效')
  const url = typeof (value as Record<string, unknown>)['url'] === 'string'
    ? ((value as Record<string, unknown>)['url'] as string).trim()
    : ''
  if (!/^https:\/\//i.test(url)) throw new Error('上传响应缺少 HTTPS 图片地址')
  return url
}

/**
 * 创建页面图片上传器。
 *
 * 下载和上传都有固定超时；超时只结束等待，执行器随后失败关闭，不重试、
 * 不改用源 URL 直接提交。
 */
export function createPublishImageUploader(deps: PublishImageUploadDeps): PublishImageUploader {
  const setTimer = deps.setTimeout ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = deps.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  async function downloadHttps(url: string): Promise<unknown> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('图片 URL 无效')
    }
    if (parsed.protocol !== 'https:') throw new Error('远程图片只允许 HTTPS')

    const controller = deps.AbortController ? new deps.AbortController() : null
    let timer: unknown
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimer(() => {
        try { controller?.abort() } catch {}
        reject(new Error('图片下载超时'))
      }, DOWNLOAD_TIMEOUT_MS)
    })
    try {
      const response = await Promise.race([
        deps.fetch(parsed.href, {
          ...(controller ? { signal: controller.signal } : {}),
          credentials: 'include',
        }),
        timeout,
      ])
      if (!response || response.ok !== true) throw new Error('图片下载失败')
      return await Promise.race([response.blob(), timeout])
    } finally {
      clearTimer(timer)
    }
  }

  async function uploadBlob(blob: unknown): Promise<PublishUploadedImage> {
    const meta = await deps.readBlob(blob)
    if (!Number.isSafeInteger(meta.size) || meta.size <= 0 || meta.size > MAX_IMAGE_BYTES) throw new Error('图片大小超出限制')
    const mime = meta.type.toLowerCase()
    if (!ALLOWED_IMAGE_MIMES.has(mime)) throw new Error('不支持的图片格式')
    let timer: unknown
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimer(() => reject(new Error('图片上传超时')), UPLOAD_TIMEOUT_MS)
    })
    try {
      const result = await Promise.race([deps.upload(blob, 'upload.jpg'), timeout])
      const url = uploadedUrl(result)
      // 真实尺寸只认页面解码结果；平台响应报出的宽高可能缺失或伪造，不能采信。
      const measured = await Promise.race([deps.measure(blob), timeout])
      if (!measured || !Number.isSafeInteger(measured.width) || measured.width <= 0 ||
        !Number.isSafeInteger(measured.height) || measured.height <= 0) {
        throw new Error('无法取得真实图片宽高')
      }
      return {
        url,
        widthSize: measured.width,
        heightSize: measured.height,
      }
    } finally {
      clearTimer(timer)
    }
  }

  return {
    async upload(source) {
      if (source.kind !== 'url') throw new Error('图片来源无效')
      return uploadBlob(await downloadHttps(source.url))
    },
  }
}
