import { describe, expect, it } from 'vitest'
import { cyclePathIfAdded, liveConflicts, reachablePairs, redundantEdges, transitiveInferences } from '../src/graph'
import type { OrderEdge } from '../src/graph'

const E = (id: string, from: string, to: string): OrderEdge => ({ id, from, to })

describe('cyclePathIfAdded', () => {
  it('无环返回 null', () => {
    const edges = [E('a', 'A', 'B'), E('b', 'B', 'C')]
    expect(cyclePathIfAdded(edges, 'A', 'C')).toBe(null)
  })
  it('检测到 to→from 路径时给出完整环', () => {
    const edges = [E('a', 'A', 'B'), E('b', 'B', 'C')]
    expect(cyclePathIfAdded(edges, 'C', 'A')).toEqual(['C', 'A', 'B', 'C'])
  })
})

describe('liveConflicts', () => {
  it('按顺序接受：后到的环边被标记，先前的边不受影响', () => {
    const edges = [E('a', 'A', 'B'), E('b', 'B', 'C'), E('c', 'C', 'A')]
    const conflicts = liveConflicts(edges)
    expect([...conflicts.keys()]).toEqual(['c'])
    expect(conflicts.get('c')).toEqual(['C', 'A', 'B', 'C'])
  })
  it('去掉环上另一条边后冲突自动消失', () => {
    expect([...liveConflicts([E('a', 'A', 'B'), E('c', 'C', 'A')]).keys()]).toEqual([])
  })
})

describe('transitiveInferences', () => {
  it('导出距离≥2且无直接边的有序对；有直接边覆盖时不作为推断', () => {
    const edges = [E('a', 'A', 'B'), E('b', 'B', 'C'), E('c', 'C', 'D')]
    const inf = transitiveInferences(edges).map((e) => e.id)
    expect(inf.sort()).toEqual(['inf:A→C', 'inf:A→D', 'inf:B→D'])
  })
  it('直接观察边优先：A→C 已有观察时不产生推断 A→C', () => {
    const edges = [E('a', 'A', 'B'), E('b', 'B', 'C'), E('d', 'A', 'C')]
    expect(transitiveInferences(edges).map((e) => e.id)).toEqual([])
  })
})

describe('reachablePairs / redundantEdges', () => {
  it('闭包包含直接与传递可达对', () => {
    const edges = [E('a', 'A', 'B'), E('b', 'B', 'C')]
    expect(reachablePairs(edges)).toEqual(['A→B', 'A→C', 'B→C'])
  })
  it('被其他路径蕴含的边标记为冗余（只隐藏不删除）', () => {
    const edges = [E('a', 'A', 'B'), E('b', 'B', 'C'), E('d', 'A', 'C')]
    expect([...redundantEdges(edges)]).toEqual(['d'])
  })
})
