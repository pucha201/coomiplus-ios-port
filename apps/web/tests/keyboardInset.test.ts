import { describe, expect, it } from 'vitest'
import { keyboardInsetPx } from '@/utils/keyboardInset'

describe('键盘占位高度（visualViewport 兜底）', () => {
  it('键盘没弹：两个视口一样高，占位为 0', () => {
    expect(keyboardInsetPx(800, 800, 0)).toBe(0)
  })

  it('键盘弹出：布局视口不变、可视视口变矮，差值就是键盘高度', () => {
    expect(keyboardInsetPx(800, 480, 0)).toBe(320)
  })

  it('底部安全区已占掉的部分不再重复计算', () => {
    expect(keyboardInsetPx(800, 480, 24)).toBe(296)
  })

  it('可视视口比布局视口还大（异常输入）时不产生负值', () => {
    expect(keyboardInsetPx(480, 800, 0)).toBe(0)
  })

  it('原生侧已垫高（两者等高等价）时两条路不叠加', () => {
    expect(keyboardInsetPx(800 - 320, 800 - 320, 0)).toBe(0)
  })
})