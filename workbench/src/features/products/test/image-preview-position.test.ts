import assert from 'node:assert/strict'
import test from 'node:test'
import { imagePreviewPosition } from '../image-preview-position'

test('预览优先在缩略图右侧，垂直居中', () => {
  assert.deepEqual(imagePreviewPosition({ left: 100, right: 148, top: 300, height: 48 }, { width: 1000, height: 800 }), { left: 156, top: 184, size: 280 })
})

test('右边缘向左打开，上下边缘保持在视口内', () => {
  assert.deepEqual(imagePreviewPosition({ left: 900, right: 948, top: 0, height: 48 }, { width: 1000, height: 800 }), { left: 612, top: 8, size: 280 })
  assert.equal(imagePreviewPosition({ left: 100, right: 148, top: 760, height: 48 }, { width: 1000, height: 800 }).top, 512)
})

test('窄屏及紧凑行距预览不超出视口', () => {
  const position = imagePreviewPosition({ left: 20, right: 64, top: 160, height: 44 }, { width: 200, height: 180 })
  assert.deepEqual(position, { left: 8, top: 8, size: 164 })
})
