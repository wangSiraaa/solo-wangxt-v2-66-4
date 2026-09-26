import { beforeEach, describe, expect, it, vi } from 'vitest'

// 组件冒烟测试用桩替代真实 Cytoscape 画布（happy-dom 无 2d 上下文与布局尺寸）
vi.mock('cytoscape', () => {
  const instance = {
    destroy: vi.fn(),
    elements: vi.fn(() => ({ remove: vi.fn() })),
    add: vi.fn(),
    layout: vi.fn(() => ({ run: vi.fn() })),
    fit: vi.fn(),
    on: vi.fn(),
  }
  return { default: vi.fn(() => instance) }
})

import { createApp } from 'vue'
import App from '../src/App.vue'
import { refresh, state } from '../src/store'
import { loadSample } from '../src/store'
import { resetDb } from './helpers'

beforeEach(async () => {
  await resetDb()
})

describe('App 组件冒烟（示例工程端到端渲染）', () => {
  it('挂载后载入示例，所有关键派生数据与文本正常渲染且无运行时错误', async () => {
    await loadSample()
    document.body.innerHTML = '<div id="app"></div>'
    const app = createApp(App)
    app.mount('#app')

    // 关键标题/段落渲染
    const text = document.body.textContent ?? ''
    expect(text).toContain('地层矩阵编辑台')
    expect(text).toContain('原始观察')
    expect(text).toContain('推断关系')
    expect(text).toContain('缺失附件'.slice(0, 4))
    // 缺失附件横幅出现（示例 E9）
    expect(text).toContain('IMG_missing.jpg')

    // 已撤销复核的按钮可用性：lastReview 仍存在（V8 已撤销，因此“撤销最近复核”应无可用项）
    // V8 undone 且其余复核都生效 -> 最近生效复核存在（V7）
    expect(text).toContain('撤销最近复核')

    // 关系列表包含示例条目
    expect(state.relations.length).toBeGreaterThanOrEqual(12)

    app.unmount()
  })

  it('空工程也能正常挂载（不报错），并提示载入示例', async () => {
    await refresh()
    document.body.innerHTML = '<div id="app"></div>'
    const app = createApp(App)
    app.mount('#app')
    expect(document.body.textContent).toContain('尚无层位')
    app.unmount()
  })
})
