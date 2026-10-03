import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  extractToken,
  generateSignature,
  getFullToken,
  md5,
  parseToken,
  redactSecret,
} from '../xianyu/sign'

/** node:crypto 作为标准 MD5(UTF-8) 参考实现。 */
function stdMd5(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex')
}

test('md5：已知固定向量', () => {
  assert.equal(md5(''), 'd41d8cd98f00b204e9800998ecf8427e')
  assert.equal(md5('abc'), '900150983cd24fb0d6963f7d28e17f72')
  assert.equal(md5('message digest'), 'f96b697d7cb7938d525a2f31aaf161d0')
  assert.equal(md5('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6')
})

test('md5：与标准 MD5(UTF-8) 一致（含中文 / 长串 / JSON）', () => {
  const inputs = [
    '',
    'abc',
    'abcdefghijklmnopqrstuvwxyz',
    '中文测试',
    '闲鱼 MTOP 签名 token&1234567890&34839810&{"itemId":"123"}',
    '123456789012345678901234567890',
    'a'.repeat(1000),
    '{"keyword":"iPhone 17","pageNumber":1}',
    'emoji 🐟 混排 test',
  ]
  for (const input of inputs) {
    assert.equal(md5(input), stdMd5(input), `md5 不一致: ${JSON.stringify(input)}`)
  }
})

test('token：从 cookie 解析完整值并去掉时间戳后缀', () => {
  const cookie = 'a=1; _m_h5_tk=abc_1766679362907; _m_h5_tk_enc=encvalue; b=2'
  assert.equal(getFullToken(cookie), 'abc_1766679362907')
  assert.equal(parseToken('abc_1766679362907'), 'abc')
  assert.equal(extractToken(cookie), 'abc')
})

test('token：不会把 _m_h5_tk_enc 当成 token', () => {
  assert.equal(getFullToken('_m_h5_tk_enc=encvalue'), null)
  assert.equal(extractToken('foo=1; bar=2'), null)
})

test('token：无下划线时 split 行为与原实现一致', () => {
  assert.equal(parseToken('plain'), 'plain')
})

test('generateSignature：字段与签名公式与旧实现一致', () => {
  const data = { itemId: '123' }
  const result = generateSignature(data, { token: 'tok', timestamp: '1700000000000' })
  const expectedString = 'tok&1700000000000&34839810&{"itemId":"123"}'
  assert.equal(result.signString, expectedString)
  assert.equal(result.sign, stdMd5(expectedString))
  assert.equal(result.t, '1700000000000')
  assert.equal(result.appKey, '34839810')
  assert.equal(result.token, 'tok')
  assert.equal(result.data, '{"itemId":"123"}')
})

test('generateSignature：data 为字符串时原样使用；appKey 可自定义', () => {
  const result = generateSignature('raw-data', { token: 't', timestamp: '1', appKey: 'OTHER' })
  assert.equal(result.data, 'raw-data')
  assert.equal(result.appKey, 'OTHER')
  assert.equal(result.sign, stdMd5('t&1&OTHER&raw-data'))
})

test('redactSecret：只暴露“是否有值”，不泄露内容', () => {
  assert.equal(redactSecret('secret-token'), '***')
  assert.equal(redactSecret(''), '')
  assert.equal(redactSecret(null), '')
  assert.equal(redactSecret(undefined), '')
})
