// 测试前置：用 fake-indexeddb 在内存中提供 IndexedDB（在被测模块载入前生效）
import 'fake-indexeddb/auto'

// happy-dom 下这些 API 可能为空，统一补上无害桩，保证导出等流程可跑通
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:test'
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => {}
}
if (typeof HTMLAnchorElement.prototype.click !== 'function') {
  HTMLAnchorElement.prototype.click = () => {}
}
// happy-dom 不实现对话框 API，默认确认（个别用例可用 vi.fn 覆盖）
if (typeof window.confirm !== 'function') {
  window.confirm = () => true
}
if (typeof window.alert !== 'function') {
  window.alert = () => {}
}
// happy-dom 不提供 canvas 2d 上下文：冒烟测试只需 Cytoscape 完成挂载，给一个最小桩
if (typeof HTMLCanvasElement.prototype.getContext === 'function') {
  const original = HTMLCanvasElement.prototype.getContext.bind(HTMLCanvasElement.prototype)
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
    try {
      const ctx = original(...(args as []))
      if (ctx) return ctx
    } catch {
      /* fall through to stub */
    }
    return new Proxy(
      {},
      {
        get: () => () => {},
      },
    ) as unknown as CanvasRenderingContext2D
  } as typeof HTMLCanvasElement.prototype.getContext
}
