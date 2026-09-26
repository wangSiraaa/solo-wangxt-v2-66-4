import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  conflictInfo,
  gateState,
  inferredEdges,
  loadSample,
  orderEdges,
  state,
  statusOf,
} from '../src/store'
import { resetDb } from './helpers'
import { reachablePairs } from '../src/graph'

beforeEach(async () => {
  await resetDb()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('示例工程自检', () => {
  it('混合状态/待复核环/缺失附件/旧推断存档/实时推断均符合脚本', async () => {
    await loadSample()

    const find = (id: string) => state.relations.find((r) => r.id === id)!
    const lab = (id: string) => state.units.find((u) => u.id === id)!.label
    const edgeLabels = () => orderEdges.value.map((e) => `${lab(e.from)}→${lab(e.to)}`).sort()

    // R1/R2/R3 已采纳生效；R4 采纳+驳回混合 => 未解决否决，不生效
    expect(gateState(find('R1'))).toBe('valid')
    expect(gateState(find('R2'))).toBe('valid')
    expect(gateState(find('R3'))).toBe('valid')
    expect(gateState(find('R4'))).toBe('rejected')

    // R6/R7 已采纳，构成灰坑链；R10 当前待复核（撤销过采纳）→ 无环冲突
    expect(gateState(find('R6'))).toBe('valid')
    expect(gateState(find('R7'))).toBe('valid')
    expect(statusOf('E8')).toBe('pending')
    expect(conflictInfo.value.size).toBe(0)

    // R11 待复核不进入矩阵，且其附件本机缺失被显式标记
    expect(gateState(find('R11'))).toBe('pending')
    expect(state.missingAttachmentIds.has('E9')).toBe(true)
    const missingEv = state.evidences.find((e) => e.id === 'E9')!
    expect(missingEv.attachment?.name).toBe('IMG_missing.jpg')

    // E3 有真实附件，不缺失
    expect(state.missingAttachmentIds.has('E3')).toBe(false)

    // 旧版手填推断 R5/R8 不参与计算：有效边里没有它们
    expect(edgeLabels()).not.toContain('1005→1003')
    expect(edgeLabels()).not.toContain('1009→1003')
    // 但有效观察仍导出了真实的传递推断（R6: 1012→1010 与 R7: 1010→1009 已采纳）
    const inf = inferredEdges.value.map((e) => `${lab(e.from)}→${lab(e.to)}`)
    expect(inf).toContain('1012→1009')
    // R4 被否决导致 1007→1005 不成立：门槛规则同样作用于推断重算
    expect(inf).not.toContain('1007→1005')
    // 审计链保留一条已撤销记录
    const undone = state.reviews.filter((r) => r.undone)
    expect(undone.length).toBe(1)
    expect(undone[0].evidenceId).toBe('E8')
    // 可达闭包非空
    expect(reachablePairs(orderEdges.value).length).toBeGreaterThan(0)
  })
})
