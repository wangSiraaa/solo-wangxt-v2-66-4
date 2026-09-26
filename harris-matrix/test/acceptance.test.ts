import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reachablePairs } from '../src/graph'
import {
  conflictInfo,
  evidenceById,
  gateState,
  inferredEdges,
  lastReview,
  matrixEdges,
  orderEdges,
  refresh,
  reviewsOf,
  state,
  statusOf,
  undoReview,
} from '../src/store'
import { addPendingEvidence, captureExportJson, makeFile, makeObservation, makeUnits, pairsAsLabels, relByEndpoints, resetDb, review, unitId } from './helpers'

function labelsOfEdges(): string[] {
  return matrixEdges.value
    .filter((e) => !e.id.startsWith('inf:'))
    .map((e) => `${lab(e.from)}→${lab(e.to)}`)
    .sort()
}
function labelsOfInferred(): string[] {
  return inferredEdges.value.map((e) => `${lab(e.from)}→${lab(e.to)}`).sort()
}
function lab(id: string) {
  return state.units.find((u) => u.id === id)?.label ?? id
}

beforeEach(async () => {
  await resetDb()
  await makeUnits(['A', 'B', 'C', 'D'])
})

describe('验收1：待复核证据不影响矩阵', () => {
  it('登记观察后默认无证据不生效；添加待复核证据后仍不产生边、不产生推断', async () => {
    const r1 = await makeObservation('A', 'B')
    const r2 = await makeObservation('B', 'C')
    expect(gateState(state.relations.find((x) => x.id === r1)!)).toBe('pending')
    expect(labelsOfEdges()).toEqual([])
    expect(reachablePairs(orderEdges.value)).toEqual([])

    await addPendingEvidence(r1)
    await addPendingEvidence(r2)
    // 仍是待复核：矩阵与偏序闭包保持为空
    expect(statusOf(state.evidences.find((e) => e.relationId === r1)!.id)).toBe('pending')
    expect(labelsOfEdges()).toEqual([])
    expect(labelsOfInferred()).toEqual([])
    expect(reachablePairs(orderEdges.value)).toEqual([])
  })
})

describe('验收2：采纳后生成新的传递结论，撤销后结论消失', () => {
  it('采纳 A→B、B→C 后出现推断 A→C；撤销最近一次采纳，推断随之消失', async () => {
    const r1 = await makeObservation('A', 'B')
    const r2 = await makeObservation('B', 'C')
    const e1 = await addPendingEvidence(r1)
    const e2 = await addPendingEvidence(r2)

    await review(e1, 'adopt', '甲')
    expect(labelsOfEdges()).toEqual(['A→B'])
    expect(labelsOfInferred()).toEqual([])

    await review(e2, 'adopt', '甲')
    expect(labelsOfEdges()).toEqual(['A→B', 'B→C'])
    // 新的传递结论实时出现
    expect(labelsOfInferred()).toEqual(['A→C'])
    expect(pairsAsLabels(reachablePairs(orderEdges.value))).toEqual(['A→B', 'A→C', 'B→C'])

    // 撤销最近一次复核（B→C 的采纳）：边与传递结论都消失
    await undoReview()
    expect(gateState(state.relations.find((x) => x.id === r2)!)).toBe('pending')
    expect(labelsOfEdges()).toEqual(['A→B'])
    expect(labelsOfInferred()).toEqual([])
    expect(pairsAsLabels(reachablePairs(orderEdges.value))).toEqual(['A→B'])
    // 但历史记录仍保留
    expect(reviewsOf(e2).length).toBe(1)
    expect(reviewsOf(e2)[0].undone).toBe(true)
  })
})

describe('验收3：同一关系多证据混合状态按规则生效', () => {
  it('已采纳+已驳回（未解决否决）=> 不生效；再采纳驳回项 => 恢复生效', async () => {
    const r = await makeObservation('A', 'B')
    const eOk = await addPendingEvidence(r, 'photo')
    const eBad = await addPendingEvidence(r, 'survey')

    await review(eOk, 'adopt', '甲')
    expect(gateState(state.relations.find((x) => x.id === r)!)).toBe('valid')
    expect(labelsOfEdges()).toEqual(['A→B'])

    await review(eBad, 'reject', '乙', '依据不足')
    // 有采纳也有未解决否决 => 不进入偏序
    expect(gateState(state.relations.find((x) => x.id === r)!)).toBe('rejected')
    expect(labelsOfEdges()).toEqual([])
    expect(reachablePairs(orderEdges.value)).toEqual([])

    // 再次采纳该条（否决被解决）=> 恢复生效，无需删除任何历史
    await review(eBad, 'adopt', '乙', '新材料确认')
    expect(statusOf(eBad)).toBe('accepted')
    expect(gateState(state.relations.find((x) => x.id === r)!)).toBe('valid')
    expect(labelsOfEdges()).toEqual(['A→B'])
  })

  it('撤销最近复核可回滚混合状态：valid → rejected 之间正确往返', async () => {
    const r = await makeObservation('A', 'B')
    const eOk = await addPendingEvidence(r)
    const eBad = await addPendingEvidence(r)
    await review(eOk, 'adopt', '甲')
    await review(eBad, 'reject', '乙')
    expect(gateState(state.relations.find((x) => x.id === r)!)).toBe('rejected')

    await undoReview() // 撤销驳回
    expect(gateState(state.relations.find((x) => x.id === r)!)).toBe('valid')
    await undoReview() // 撤销采纳
    expect(gateState(state.relations.find((x) => x.id === r)!)).toBe('pending')
    expect(lastReview.value).toBeNull()
  })
})

describe('验收4：采纳造成环时保留复核决定并生成冲突，而非静默丢弃', () => {
  it('A→B→C 已生效后，采纳 C→A：决定保留、红边冲突、不进入偏序与推断', async () => {
    const r1 = await makeObservation('A', 'B')
    const r2 = await makeObservation('B', 'C')
    const r3 = await makeObservation('C', 'A')
    const e1 = await addPendingEvidence(r1)
    const e2 = await addPendingEvidence(r2)
    const e3 = await addPendingEvidence(r3)
    await review(e1, 'adopt')
    await review(e2, 'adopt')
    expect(conflictInfo.value.has(r3)).toBe(false)

    await review(e3, 'adopt', '乙', '我认为 C 更早')
    // 决定保留
    expect(statusOf(e3)).toBe('accepted')
    // 但实时标记冲突，并给出完整环路径
    expect(conflictInfo.value.has(r3)).toBe(true)
    const cycle = conflictInfo.value.get(r3)!.map(lab)
    expect(cycle[0]).toBe('C')
    expect(cycle[cycle.length - 1]).toBe('C')
    expect(cycle.slice(1, -1).sort()).toEqual(['A', 'B'])
    // 冲突边不进入偏序计算：可达对仍是 A→B→C 的两条传递
    expect(pairsAsLabels(reachablePairs(orderEdges.value))).toEqual(['A→B', 'A→C', 'B→C'])
    // 撤销该采纳：冲突解除
    await undoReview()
    expect(conflictInfo.value.has(r3)).toBe(false)
  })

  it('否决环上的另一条边后，原冲突自动解除（冲突随有效观察集实时重算）', async () => {
    const r1 = await makeObservation('A', 'B')
    const r2 = await makeObservation('B', 'C')
    const r3 = await makeObservation('C', 'A')
    const e1 = await addPendingEvidence(r1)
    const e2 = await addPendingEvidence(r2)
    const e3 = await addPendingEvidence(r3)
    await review(e1, 'adopt')
    await review(e2, 'adopt')
    await review(e3, 'adopt')
    expect(conflictInfo.value.size).toBe(1)
    // 驳回 B→C 的唯一采纳证据
    await review(e2, 'reject', '甲')
    // C→A 不再成环（A→B 与 C→A、C 无路径到 A）
    expect(conflictInfo.value.size).toBe(0)
  })
})

describe('验收5：刷新后审计链与计算结果一致（纯前端持久化）', () => {
  it('重新 refresh（模拟刷新页面）后状态、审计、冲突、推断完全一致', async () => {
    const r1 = await makeObservation('A', 'B')
    const r2 = await makeObservation('B', 'C')
    const r3 = await makeObservation('C', 'A')
    const e1 = await addPendingEvidence(r1)
    const e2 = await addPendingEvidence(r2)
    const e3 = await addPendingEvidence(r3)
    await review(e1, 'adopt', '甲', '采纳意见')
    await review(e2, 'adopt', '甲')
    await review(e3, 'reject', '乙', '先驳回')
    await review(e3, 'adopt', '乙', '改采纳')
    const before = {
      statuses: state.evidences.map((e) => statusOf(e.id)),
      inferred: labelsOfInferred(),
      conflict: [...conflictInfo.value.keys()].sort(),
      closure: pairsAsLabels(reachablePairs(orderEdges.value)),
      reviews: state.reviews.length,
    }

    // 重新从 IndexedDB 装载（等价于刷新页面）
    state.loaded = false
    await refresh()

    expect(state.evidences.map((e) => statusOf(e.id))).toEqual(before.statuses)
    expect(labelsOfInferred()).toEqual(before.inferred)
    expect([...conflictInfo.value.keys()].sort()).toEqual(before.conflict)
    expect(pairsAsLabels(reachablePairs(orderEdges.value))).toEqual(before.closure)
    expect(state.reviews.length).toBe(before.reviews)
    // 当前生效状态由最后一条未撤销复核决定
    const chain = reviewsOf(e3)
    expect(chain.length).toBe(2)
    expect(chain[1].action).toBe('adopt')
    expect(chain[1].operator).toBe('乙')
    expect(chain[1].comment).toBe('改采纳')
    expect(statusOf(e3)).toBe('accepted')
    // 早先的驳回记录仍在审计链里（历史不删除）
    expect(chain[0]).toMatchObject({ action: 'reject', operator: '乙', comment: '先驳回' })
  })
})

describe('验收6：导出 → 重新导入后审计链、附件可用性与计算结果一致', () => {
  it('带附件导出再导入：偏序一致、审计链保留、附件可下载', async () => {
    const { exportProject, importProject, getAttachmentBlob } = await import('../src/store')
    const r1 = await makeObservation('A', 'B')
    const r2 = await makeObservation('B', 'C')
    const file = makeFile('附件正文-仅本机', 'note.txt')
    const e1 = await addPendingEvidence(r1, 'diary', file, '带附件证据')
    const e2 = await addPendingEvidence(r2)
    await review(e1, 'adopt', '甲', '采纳带附件证据')
    await review(e2, 'adopt', '乙', '采纳')

    const json = await captureExportJson(exportProject)
    expect(json.version).toBe(2)
    expect(json.attachments.length).toBe(1)
    expect(json.partialOrder).toEqual(reachablePairs(orderEdges.value))
    const snapshot = {
      closure: pairsAsLabels(reachablePairs(orderEdges.value)),
      inferred: labelsOfInferred(),
      reviewCount: state.reviews.length,
      operators: state.reviews.map((r) => r.operator).sort(),
    }

    const blob = new Blob([JSON.stringify(json)], { type: 'application/json' })
    await importProject(new File([blob], 'project.json', { type: 'application/json' }))

    // 偏序与推断一致
    expect(pairsAsLabels(reachablePairs(orderEdges.value))).toEqual(snapshot.closure)
    expect(labelsOfInferred()).toEqual(snapshot.inferred)
    // 审计链完整保留
    expect(state.reviews.length).toBe(snapshot.reviewCount)
    expect(state.reviews.map((r) => r.operator).sort()).toEqual(snapshot.operators)
    // 附件内容随导出迁移、可重新读取
    const ev = state.evidences.find((e) => e.note === '带附件证据')!
    expect(ev.attachment?.name).toBe('note.txt')
    const got = await getAttachmentBlob(ev.attachment!)
    expect(got).not.toBe(null)
    const text = new TextDecoder().decode(new Uint8Array(await got!.arrayBuffer()))
    expect(text).toBe('附件正文-仅本机')
  })

  it('附件 Blob 本机缺失时：元数据仍在、显式提示、工程可正常加载且偏序一致', async () => {
    const { exportProject, importProject } = await import('../src/store')
    const r1 = await makeObservation('A', 'B')
    const file = makeFile('x', 'ok.txt')
    const e1 = await addPendingEvidence(r1, 'diary', file, '有附件')
    await review(e1, 'adopt')
    const json = await captureExportJson(exportProject)

    // 模拟附件数据在传输中丢失：删除附件载荷，只留证据上的元数据
    json.attachments = []
    const blob = new Blob([JSON.stringify(json)], { type: 'application/json' })
    await importProject(new File([blob], 'project.json', { type: 'application/json' }))

    // 工程照常加载，证据与关系都在
    const ev = state.evidences.find((e) => e.note === '有附件')!
    expect(ev.attachment?.name).toBe('ok.txt')
    expect(state.missingAttachmentIds.has(ev.id)).toBe(true)
    // 计算结果不受影响（证据仍是已采纳）
    expect(statusOf(ev.id)).toBe('accepted')
    expect(pairsAsLabels(reachablePairs(orderEdges.value))).toEqual(['A→B'])
  })

  it('v1 旧工程导入：旧证据自动迁移为已采纳，矩阵语义保持不变', async () => {
    const { importProject } = await import('../src/store')
    // 手工构造一个 v1 导出：证据只有 ref/text、没有 reviews/attachments
    const A = unitId('A')
    const B = unitId('B')
    const v1 = {
      app: 'harris-matrix-workbench',
      version: 1,
      exportedAt: new Date().toISOString(),
      units: state.units.map((u) => ({ ...u })),
      positions: [],
      relations: [
        { id: 'old-r1', from: A, to: B, kind: 'earlier', source: 'observation', status: 'active', conflict: false, evidenceIds: ['old-e1'], note: '旧观察', createdAt: 1 },
      ],
      evidences: [{ id: 'old-e1', ref: '田野日记·1页', text: '旧证据文本', createdAt: 1 }],
      retractions: [],
      partialOrder: [`${A}→${B}`],
    }
    const blob = new Blob([JSON.stringify(v1)], { type: 'application/json' })
    window.confirm = vi.fn(() => true)
    await importProject(new File([blob], 'v1.json', { type: 'application/json' }))

    const rel = relByEndpoints('A', 'B')
    expect(gateState(rel)).toBe('valid')
    const ev = evidenceById('old-e1')
    expect(ev).toBeDefined()
    expect(ev!.relationId).toBe(rel.id)
    expect(ev!.type).toBe('other')
    expect(ev!.collectedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(statusOf('old-e1')).toBe('accepted')
    // 迁移采纳是一条显式审计
    const chain = reviewsOf('old-e1')
    expect(chain.length).toBe(1)
    expect(chain[0].operator).toBe('系统迁移')
    expect(pairsAsLabels(reachablePairs(orderEdges.value))).toEqual(['A→B'])
  })
})
