import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncBuild } from './agent-build.mjs'
import { inspectAgentOutput } from './agent-output.mjs'
import { reloadUnpacked, uninstallExtension } from './agent-reload.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fishops-agent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const target = join(root, 'agent-extension')
  await mkdir(source)
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ manifest_version: 3 }))
  await writeFile(join(source, 'workbench.html'), '<main>workbench</main>')
  return { root, source, target }
}

test('切换 worktree 后清除旧 chunk，记录新来源，保留源目录', async t => {
  const { source, target } = await fixture(t)
  await writeFile(join(source, 'old-chunk.js'), 'old')
  await syncBuild(source, target, { worktree: '/worktree/a', commit: 'aaa' })
  await rm(join(source, 'old-chunk.js'))
  await writeFile(join(source, 'new-chunk.js'), 'new')
  await syncBuild(source, target, { worktree: '/worktree/b', commit: 'bbb' })
  await assert.rejects(readFile(join(target, 'old-chunk.js')), { code: 'ENOENT' })
  assert.equal(await readFile(join(target, 'new-chunk.js'), 'utf8'), 'new')
  assert.equal(await readFile(join(source, 'new-chunk.js'), 'utf8'), 'new')
  const metadata = JSON.parse(await readFile(join(target, '.fishops-agent-build.json'), 'utf8'))
  assert.equal(metadata.worktree, '/worktree/b')
  assert.equal(metadata.commit, 'bbb')
})

test('不完整构建不会覆盖已有可加载版本', async t => {
  const { source, target } = await fixture(t)
  await syncBuild(source, target, { commit: 'old' })
  await rm(join(source, 'workbench.html'))
  await assert.rejects(syncBuild(source, target, { commit: 'new' }))
  const metadata = JSON.parse(await readFile(join(target, '.fishops-agent-build.json'), 'utf8'))
  assert.equal(metadata.commit, 'old')
})

test('拒绝覆盖其他目录和并发更新', async t => {
  const { source, target } = await fixture(t)
  await mkdir(target)
  await writeFile(join(target, 'manifest.json'), 'keep')
  await assert.rejects(syncBuild(source, target, {}), /非脚本管理/)
  assert.equal(await readFile(join(target, 'manifest.json'), 'utf8'), 'keep')
  await mkdir(`${target}.lock`)
  await assert.rejects(syncBuild(source, target, {}), /正在更新/)
  assert.equal(await readFile(join(target, 'manifest.json'), 'utf8'), 'keep')
})

test('stderr 完成结果有效；停止信号与中途退出不能被报告为成功', () => {
  assert.equal(inspectAgentOutput('', 'FISHOPS: SETUP_COMPLETED：完成', 0).completed, true)
  assert.equal(inspectAgentOutput('FISHOPS: SETUP_COMPLETED：完成', 'user has taken control', 0).completed, false)
  assert.equal(inspectAgentOutput('FISHOPS: 测试空间：263', '', 0).completed, false)
  assert.equal(inspectAgentOutput('FISHOPS: INSTALL_REQUIRED：固定目录尚未安装', '', 1).installRequired, true)
  assert.equal(inspectAgentOutput('FISHOPS: 测试空间：263', '', 0).installRequired, false)
  assert.equal(inspectAgentOutput('FISHOPS: SETUP_COMPLETED：完成', '', 1).completed, false)
  assert.deepEqual(inspectAgentOutput('sensitive runtime trace', 'FISHOPS: 配置已保存', 1).lines, [' 配置已保存'])
})

test('扩展尚未加载完时不得提前继续打开工作台；加载失败必须中止', async () => {
  let loaded = false
  const api = {
    reload(id, options, callback) {
      if (!options.populateErrorForUnpacked) callback()
      setTimeout(() => {
        loaded = true
        if (options.populateErrorForUnpacked) callback()
      }, 5)
    },
  }
  await reloadUnpacked('test-extension', api)
  assert.equal(loaded, true)
  await assert.rejects(reloadUnpacked('test-extension', { reload(id, options, callback) { callback({ error: 'bad manifest' }) } }), /重载失败/)
})

test('仅测试副本声明 AI 域名权限，原构建 manifest 保持不变', async t => {
  const { source, target } = await fixture(t)
  await syncBuild(source, target, { aiPermissionOrigin: 'https://ai.example.test' })
  assert.deepEqual(JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')).host_permissions, ['https://ai.example.test/*'])
  assert.equal(JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')).host_permissions, undefined)
})

test('只从目标自身页面发起无确认卸载，禁止跨插件误删', () => {
  let requested = false
  const api = {
    uninstallSelf(options) {
      assert.equal(options.showConfirmDialog, false)
      requested = true
    },
  }
  assert.throws(() => uninstallExtension('test-extension', { id: 'other-extension' }, api), /不一致/)
  assert.equal(requested, false)
  assert.equal(uninstallExtension('test-extension', { id: 'test-extension' }, api), true)
  assert.equal(requested, true)
})
