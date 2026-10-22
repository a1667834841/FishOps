/**
 * 飞书字段 schema reconciliation 纯逻辑测试。
 *
 * 验证：
 * 1. 本地投影覆盖既有写入字段配置（名称 + 类型），并集不产生名称级冲突；
 * 2. 投影字段名唯一（别名映射不碰撞）；
 * 3. diffFeishuSchema 分类正确，且「哪边字段更多」采用并集而非破坏性覆盖；
 * 4. API 能力声明：可创建、不可安全改类型、绝不删除。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FEISHU_SCHEMA_RECONCILE_CAPABILITY,
  FEISHU_SCHEMA_RECONCILE_STRATEGY,
  LOCAL_PRODUCT_FEISHU_FIELD_PROJECTION,
  diffFeishuSchema,
  mapDatasetTypeToFeishuType,
} from '../../../../shared/data-source/feishu-schema-reconcile'
import { FEISHU_PRODUCT_FIELD_CONFIGS } from '../../../../shared/data-source/feishu-types'
import { LOCAL_PRODUCT_DATASET_SCHEMA } from '../../../../shared/data-source/local-data-source'

test('本地投影覆盖既有写入字段配置（名称与类型一致）', () => {
  const projectionByName = new Map(LOCAL_PRODUCT_FEISHU_FIELD_PROJECTION.map((f) => [f.name, f.type]))
  for (const config of FEISHU_PRODUCT_FIELD_CONFIGS) {
    assert.equal(projectionByName.get(config.name), config.type, `字段 ${config.name} 的投影类型应一致`)
  }
})

test('投影字段名唯一且与本地字段一一对应', () => {
  const names = LOCAL_PRODUCT_FEISHU_FIELD_PROJECTION.map((f) => f.name)
  const projectionByName = new Map(LOCAL_PRODUCT_FEISHU_FIELD_PROJECTION.map((f) => [f.name, f.type]))
  assert.equal(new Set(names).size, names.length)
  assert.equal(LOCAL_PRODUCT_FEISHU_FIELD_PROJECTION.length, LOCAL_PRODUCT_DATASET_SCHEMA.fields.length)
  assert.equal(projectionByName.get('商品描述'), 1)
})

test('数据集类型到飞书类型映射', () => {
  assert.equal(mapDatasetTypeToFeishuType('string'), 1)
  assert.equal(mapDatasetTypeToFeishuType('boolean'), 1)
  assert.equal(mapDatasetTypeToFeishuType('number'), 2)
  assert.equal(mapDatasetTypeToFeishuType('datetime'), 5)
  assert.equal(mapDatasetTypeToFeishuType('url'), 15)
})

test('并集策略：两边缺的字段都报告，绝不因字段更多而删除另一方', () => {
  const desired = [
    { name: '本地独有', type: 1 },
    { name: '共有', type: 2 },
    { name: '类型冲突', type: 2 },
  ]
  const actual = [
    { name: '共有', type: 2 },
    { name: '类型冲突', type: 1 },
    { name: '飞书独有', type: 5 },
  ]

  const diff = diffFeishuSchema(desired, actual)
  assert.equal(FEISHU_SCHEMA_RECONCILE_STRATEGY, 'UNION')
  // 并集大小 = 4，既不丢本地独有，也不删飞书独有。
  assert.equal(diff.targetFieldCount, 4)
  assert.deepEqual(diff.toCreate, [{ name: '本地独有', type: 1 }])
  assert.deepEqual(diff.inSync, ['共有'])
  assert.deepEqual(diff.typeConflicts, [{ name: '类型冲突', expectedType: 2, actualType: 1 }])
  assert.deepEqual(diff.feishuOnly, ['飞书独有'])

  // 同一字段不会既待创建又冲突。
  const created = new Set(diff.toCreate.map((f) => f.name))
  for (const conflict of diff.typeConflicts) {
    assert.equal(created.has(conflict.name), false)
  }
})

test('API 能力：可创建、不可安全改类型、绝不删除', () => {
  assert.equal(FEISHU_SCHEMA_RECONCILE_CAPABILITY.canCreateField, true)
  assert.equal(FEISHU_SCHEMA_RECONCILE_CAPABILITY.canUpdateFieldType, false)
  assert.equal(FEISHU_SCHEMA_RECONCILE_CAPABILITY.canDeleteField, false)
  assert.equal(FEISHU_SCHEMA_RECONCILE_CAPABILITY.notes.length > 0, true)
})
