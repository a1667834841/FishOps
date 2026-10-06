import assert from 'node:assert/strict'
import test from 'node:test'
import { imagePreviewPosition } from '../image-preview-position'

test('预览在视口中央，占宽高的三分之二', () => {
  assert.deepEqual(imagePreviewPosition({ width: 1200, height: 900 }), { left: 200, top: 150, width: 800, height: 600 })
})

test('窄屏与横屏均按视口比例居中，不超出屏幕', () => {
  for (const viewport of [{ width: 180, height: 300 }, { width: 900, height: 180 }]) {
    const position = imagePreviewPosition(viewport)
    assert.equal(position.width, viewport.width * 2 / 3)
    assert.equal(position.height, viewport.height * 2 / 3)
    assert.equal(position.left, (viewport.width - position.width) / 2)
    assert.equal(position.top, (viewport.height - position.height) / 2)
  }
})
