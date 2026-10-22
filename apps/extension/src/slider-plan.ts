/**
 * 滑块验证定位与拖动计划（纯计算，不发起任何交互）。
 *
 * 设计约束：
 * - 本模块只读页面 DOM 计算「该拖多远、按什么节奏拖」，绝不自己派发事件；
 *   真实鼠标事件由 SW 侧 `chrome.debugger` 在目标标签页派发，避免 MAIN world
 *   内合成事件被平台识别为非真实输入。
 * - 位移只来自 DOM 可观测信息：优先缺口位置，缺口不可见时退到滑块最大行程。
 *   不写入逆向得到的固定像素值，平台改版后不会静默拖错位置。
 * - 只处理滑块类验证；短信、扫码、人脸等类型没有可拖动元素，直接判定不可自动处理。
 */

/** 滑块手柄候选选择器；顺序即优先级，命中第一个可见元素。 */
const SLIDER_SELECTORS: readonly string[] = [
  '#nc_1_n1z',
  '.btn_slide',
  'span[id*="_n1z"]',
  '.nc_iconfont.btn_slide',
  '[role="slider"]',
]

/** 滑块轨道候选选择器；轨道决定可拖动范围。 */
const TRACK_SELECTORS: readonly string[] = ['.nc_scale', '.scale_text', '#nc_1__scale_text']

/** 滑块弹窗容器候选；用于确认验证类型与等待弹窗消失。 */
const DIALOG_SELECTORS: readonly string[] = [
  '.baxia-dialog',
  '#baxia-dialog',
  '[id*="baxia-dialog"]',
  '#nc_1_wrapper',
  '.nc-container',
  '#nocaptcha',
]

/** 缺口（拼图块）候选；有缺口时按缺口位置计算位移，比最大行程更准。 */
const GAP_SELECTORS: readonly string[] = ['.nc_1_n1t', '#nc_1_n1t', '[class*="nc_1_n1t"]', '[class*="slide-code"]']

/** 单点坐标；与 CDP `Input.dispatchMouseEvent` 的 x/y 语义一致。 */
export interface Point {
  x: number
  y: number
}

/** 一次拖动计划；SW 侧按顺序派发，不得改写数值。 */
export interface SliderPlan {
  /** 手柄按下点（视口坐标）。 */
  from: Point
  /** 期望到达点（视口坐标）。 */
  to: Point
  /** 水平位移像素；正数向右。 */
  distance: number
  /** 移动轨迹关键点（含起点与终点）；长度与间隔由 {@link sliderMoveTrack} 决定。 */
  path: readonly Point[]
  /** 定位依据，便于诊断与测试断言；不含任何平台内部字段。 */
  reason: 'gap' | 'track'
}

/** 定位失败的原因分类；只用于内部判断，不作为对外错误码。 */
export type SliderLocateFailure = 'no-dialog' | 'no-slider' | 'no-track' | 'no-size'

/** 最小可观测尺寸；低于该值的元素视为未渲染完成。 */
const MIN_SIZE_PX = 1

/** 矩形的最小读取面；只取拖动必需的四个字段。 */
interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

/** DOM 读取的最小面；生产传真实 document，测试传替身。 */
export interface SliderDom {
  querySelector(selector: string): SliderElement | null
}

export interface SliderElement {
  getBoundingClientRect(): RectLike
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isVisible(element: SliderElement | null): element is SliderElement {
  if (!element) return false
  const rect = element.getBoundingClientRect()
  return finite(rect.width) && finite(rect.height) && rect.width >= MIN_SIZE_PX && rect.height >= MIN_SIZE_PX
}

/** 按优先级取第一个可见元素。 */
function firstVisible(dom: SliderDom, selectors: readonly string[]): SliderElement | null {
  for (const selector of selectors) {
    const element = dom.querySelector(selector)
    if (isVisible(element)) return element
  }
  return null
}

function rectOf(element: SliderElement): RectLike | null {
  const rect = element.getBoundingClientRect()
  if (!finite(rect.left) || !finite(rect.top) || !finite(rect.width) || !finite(rect.height)) return null
  if (rect.width < MIN_SIZE_PX || rect.height < MIN_SIZE_PX) return null
  return rect
}

function centerOf(rect: RectLike): Point {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

/**
 * 生成带加速度特征的移动轨迹。
 *
 * 真人拖动不是匀速直线：起步慢、中段快、接近目标时减速。平台常按
 * 「位移-时间」曲线判断是否为脚本，因此这里显式构造非匀速轨迹，
 * 并在终点附近加入小幅回弹，避免机械地一次到位。
 *
 * @param from 起点
 * @param distance 水平位移；非正数时返回空数组表示无可执行轨迹
 * @param steps 轨迹点数（不含起点）；过少会退化成匀速，过多无益
 */
export function sliderMoveTrack(from: Point, distance: number, steps = 24): Point[] {
  if (!finite(from.x) || !finite(from.y) || !finite(distance) || distance <= 0) return []
  if (!Number.isInteger(steps) || steps < 4) return []
  const path: Point[] = []
  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps
    // easeInOutQuad：两端慢、中段快，接近人类拖动的速度分布。
    const eased = progress < 0.5 ? 2 * progress * progress : 1 - (1 - progress) ** 2 * 2
    // 末段回弹：倒数第二点先略微越过再回落，模拟手指到位前的微调；
    // 最后一点强制落到精确目标，避免 overshoot 造成系统性偏移。
    const overshoot = index === steps - 1 ? 0 : index === steps - 2 ? 0.02 : 0
    path.push({ x: from.x + distance * (eased + overshoot), y: from.y })
  }
  // 终点必须精确落在目标上，修正 overshoot 带来的偏移。
  path[path.length - 1] = { x: from.x + distance, y: from.y }
  return path
}

/**
 * 在当前文档定位滑块并计算拖动计划。
 *
 * @param dom 文档读取面；缺失或未匹配到弹窗时返回 null，由调用方回落人工验证
 * @returns 拖动计划；无法定位时返回 null
 */
export function locateSlider(dom: SliderDom): SliderPlan | null {
  if (!dom || typeof dom.querySelector !== 'function') return null
  // 没有弹窗容器即认为当前不是滑块验证场景，避免误拖页面上的其它滑块控件。
  if (!firstVisible(dom, DIALOG_SELECTORS)) return null
  const slider = firstVisible(dom, SLIDER_SELECTORS)
  if (!slider) return null
  const sliderRect = rectOf(slider)
  if (!sliderRect) return null
  const from = centerOf(sliderRect)
  const track = firstVisible(dom, TRACK_SELECTORS)
  const trackRect = track ? rectOf(track) : null
  // 缺口优先：缺口左边界与手柄左边的距离就是需要补齐的位移。
  const gap = firstVisible(dom, GAP_SELECTORS)
  const gapRect = gap ? rectOf(gap) : null
  if (gapRect) {
    const distance = gapRect.left - sliderRect.left
    if (distance > MIN_SIZE_PX) {
      return {
        from,
        to: { x: from.x + distance, y: from.y },
        distance,
        path: sliderMoveTrack(from, distance),
        reason: 'gap',
      }
    }
  }
  // 缺口不可见时退到最大行程：轨道右边减去手柄当前右边。
  if (trackRect) {
    const distance = trackRect.left + trackRect.width - (sliderRect.left + sliderRect.width)
    if (distance > MIN_SIZE_PX) {
      return {
        from,
        to: { x: from.x + distance, y: from.y },
        distance,
        path: sliderMoveTrack(from, distance),
        reason: 'track',
      }
    }
  }
  return null
}

/**
 * 判断当前文档是否仍展示滑块验证弹窗。
 *
 * 拖动结束后轮询本函数：返回 false 视为验证已通过，返回 true 视为仍未通过。
 * 只判断弹窗容器，不判断具体滑块元素，兼容平台在通过后保留动画容器的情况。
 */
export function sliderDialogVisible(dom: SliderDom): boolean {
  if (!dom || typeof dom.querySelector !== 'function') return false
  return firstVisible(dom, DIALOG_SELECTORS) !== null
}
