/** 计算悬浮图片预览的位置与尺寸，优先放在缩略图右侧，并限制在视口内。 */
export function imagePreviewPosition(
  anchor: { left: number; right: number; top: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number; size: number } {
  const margin = 8
  const size = Math.max(0, Math.min(280, viewport.width - margin * 2, viewport.height - margin * 2))
  const preferredLeft = anchor.right + margin + size <= viewport.width - margin
    ? anchor.right + margin
    : anchor.left - margin - size
  return {
    left: Math.max(margin, Math.min(preferredLeft, viewport.width - margin - size)),
    top: Math.max(margin, Math.min(anchor.top + anchor.height / 2 - size / 2, viewport.height - margin - size)),
    size,
  }
}
