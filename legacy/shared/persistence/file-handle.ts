/** 用户选定的独立文件接口；避免要求所有包依赖非标准 DOM 类型。 */
export interface BackupFileHandle {
  name: string
  getFile(): Promise<{ size: number; text(): Promise<string> }>
  queryPermission(options: { mode: 'readwrite' }): Promise<string>
  requestPermission(options: { mode: 'readwrite' }): Promise<string>
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>
}

let handleDatabase: Promise<IDBDatabase> | null = null

/** 文件句柄放在扩展 IndexedDB；卸载会删除句柄，但不会删除用户文件。 */
export async function backupHandleStore(): Promise<{
  get(): Promise<BackupFileHandle | null>
  set(handle: BackupFileHandle): Promise<void>
}> {
  const db = await (handleDatabase ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('fishops-backup-handle', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('handles')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch(error => { handleDatabase = null; throw error }))
  function operation<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('handles', mode)
      const request = run(tx.objectStore('handles'))
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(tx.error ?? new Error('备份文件句柄保存失败'))
      tx.onerror = () => reject(tx.error)
    })
  }
  return {
    get: async () => (await operation('readonly', store => store.get('selected'))) ?? null,
    set: async handle => { await operation('readwrite', store => store.put(handle, 'selected')) },
  }
}
