import { isChatWire, type ChatWire } from '../../../packages/protocol/src/chat-wire.ts'
import { isWire, type Wire } from '../../../packages/protocol/src/index.ts'
import { isPageWire, isStepWire, type PageWire, type StepWire } from '../../../packages/protocol/src/step.ts'

export type HostWire = Wire | StepWire | PageWire | ChatWire

export const MAX_FRAME = 1024 * 1024
export function encodeFrame(value: HostWire): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (!body.length || body.length > MAX_FRAME) throw new Error('FRAME_SIZE')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  return Buffer.concat([header, body])
}

/** 增量解析 native messaging 帧；任意畸形输入都会使通道失败关闭。 */
export class FrameDecoder {
  #buffer = Buffer.alloc(0)
  push(chunk: Buffer): HostWire[] {
    const frames: HostWire[] = []
    let input = chunk
    while (input.length) {
      if (this.#buffer.length < 4) {
        const take = Math.min(4 - this.#buffer.length, input.length)
        this.#buffer = Buffer.concat([this.#buffer, input.subarray(0, take)])
        input = input.subarray(take)
        if (this.#buffer.length < 4) break
      }
      const length = this.#buffer.readUInt32LE(0)
      if (!length || length > MAX_FRAME) throw new Error('FRAME_SIZE')
      const bodyLength = this.#buffer.length - 4
      const take = Math.min(length - bodyLength, input.length)
      if (take) {
        this.#buffer = Buffer.concat([this.#buffer, input.subarray(0, take)])
        input = input.subarray(take)
      }
      if (this.#buffer.length < length + 4) break
      const body = this.#buffer.subarray(4, length + 4)
      const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
      const value: unknown = JSON.parse(text)
      if (!isWire(value) && !isStepWire(value) && !isPageWire(value) && !isChatWire(value)) throw new Error('INVALID_WIRE')
      frames.push(value)
      this.#buffer = this.#buffer.subarray(length + 4)
    }
    if (this.#buffer.length > MAX_FRAME + 4) throw new Error('FRAME_SIZE')
    return frames
  }
  end(): void { if (this.#buffer.length) throw new Error('TRUNCATED_FRAME') }
}
