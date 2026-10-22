/** 将图片预览居中，占视口宽高的三分之二；图片比例由组件的 contain 保持。 */
export function imagePreviewPosition(
  viewport: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  const width = viewport.width * 2 / 3
  const height = viewport.height * 2 / 3
  return {
    left: (viewport.width - width) / 2,
    top: (viewport.height - height) / 2,
    width,
    height,
  }
}
