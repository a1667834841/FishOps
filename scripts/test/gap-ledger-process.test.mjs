import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

test('缺口账本跨进程重建：迟到 A 不推进 B，跨账号独立', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fishops-gap-process-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'host.db')
  const database = pathToFileURL(resolve(import.meta.dirname, '../../apps/host/src/database.ts')).href
  const ledger = pathToFileURL(resolve(import.meta.dirname, '../../apps/host/src/chat-gap-ledger.ts')).href
  const run = action => {
    const source = `import {HostDatabase} from ${JSON.stringify(database)};
      import {ChatGapLedger} from ${JSON.stringify(ledger)};
      const db=new HostDatabase(${JSON.stringify(path)});const ledger=new ChatGapLedger(db);
      const occurrence=(id,account='a')=>({accountId:account,reason:'PAGE_GAP',occurrenceId:id,generation:1,scope:{scope:'session',sessionId:'s'}});
      try {${action}} finally {db.close()}`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10000 })
    assert.equal(child.status, 0, child.stderr)
    return JSON.parse(child.stdout)
  }
  const first = run("ledger.ingest(occurrence('A'));ledger.ingest(occurrence('B'));console.log(JSON.stringify(ledger.snapshot('a')))")
  assert.equal(first.lines[0].generation, 2)
  const second = run("const late=ledger.ingest(occurrence('A'));ledger.ingest(occurrence('A','b'));console.log(JSON.stringify({late,a:ledger.snapshot('a'),b:ledger.snapshot('b')}))")
  assert.equal(second.late.status, 'duplicate')
  assert.equal(second.a.lines[0].generation, 2)
  assert.equal(second.a.lines[0].latestOccurrenceId, 'B')
  assert.equal(second.a.lines[0].occurrenceCount, 2)
  assert.equal(second.b.lines[0].generation, 1)
  const third = run("ledger.ingest(occurrence('C'));console.log(JSON.stringify(ledger.snapshot('a')))")
  assert.equal(third.lines[0].generation, 3)
  assert.equal(third.lines[0].occurrenceCount, 3)
})
