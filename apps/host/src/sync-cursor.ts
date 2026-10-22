import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/** 续页凭证绑定业务范围和固定文档；加密避免账号及平台游标以明文暴露。 */
export type SyncCursor = {
  version: 1; accountId: string; mode: 'conversations' | 'messages'; sessionId: string | null
  anchor: string; limit: number; tabId: number; documentId: string; runId: string; expiresAt: number
}
const id = (v: unknown) => typeof v === 'string' && !!v.trim() && v.length <= 128
function valid(v: any): v is SyncCursor {
  return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === 'accountId,anchor,documentId,expiresAt,limit,mode,runId,sessionId,tabId,version' &&
    v.version === 1 && id(v.accountId) && id(v.documentId) && id(v.runId) &&
    ((v.mode === 'conversations' && v.sessionId === null) || (v.mode === 'messages' && id(v.sessionId))) &&
    typeof v.anchor === 'string' && /^(0|[1-9]\d*)$/.test(v.anchor) && v.anchor.length <= 16 && BigInt(v.anchor) <= BigInt(Number.MAX_SAFE_INTEGER) &&
    Number.isSafeInteger(v.limit) && v.limit >= 1 && v.limit <= 100 && Number.isSafeInteger(v.tabId) && v.tabId >= 0 && Number.isSafeInteger(v.expiresAt) && v.expiresAt >= 0
}
/** 创建部署范围 AES-GCM 凭证；认证失败、过期和范围不符均返回同一固定错误。 */
export function createSyncCursorCodec(secret: string, now: () => number = Date.now) {
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('SYNC_CURSOR_CONFIG')
  const key = createHash('sha256').update('fishops.sync.cursor.v1\0').update(secret).digest()
  const bad = () => new Error('SYNC_CURSOR_INVALID')
  return {
    encode(value: SyncCursor): string {
      if (!valid(value) || value.expiresAt <= now()) throw bad()
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64url')
    },
    decode(token: string, expected: Pick<SyncCursor, 'accountId' | 'mode' | 'sessionId' | 'limit'>): SyncCursor {
      try {
        if (typeof token !== 'string' || token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) throw bad()
        const data = Buffer.from(token, 'base64url')
        if (data.length < 29 || data.toString('base64url') !== token) throw bad()
        const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
        decipher.setAuthTag(data.subarray(12, 28))
        const value = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'))
        if (!valid(value) || value.expiresAt <= now() || (Object.keys(expected) as Array<keyof typeof expected>).some(k => value[k] !== expected[k])) throw bad()
        return value
      } catch { throw bad() }
    },
  }
}
