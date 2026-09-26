/**
 * 证据复核闭环 —— 验收测试（Node + fake-indexeddb，纯逻辑链路，无浏览器）。
 * 运行：npm test
 *
 * 覆盖验收点：
 *  1. 待复核证据不影响矩阵（偏序/推断）；
 *  2. 采纳后生成新的传递结论，撤销复核后结论消失，历史不删除；
 *  3. 同一关系多证据混合状态（采纳+驳回+待复核）按规则生效；
 *  4. 采纳会造成环时保留复核决定并生成冲突，不静默丢弃、不进入偏序；
 *  5. 刷新、导出、重新导入后审计链、附件可用性与计算结果一致；
 *  6. 缺失附件显式提示但工程正常加载；
 *  7. 推断关系随有效观察集实时重算。
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

import type * as _Types from '../src/types'
type EvidenceDraft = _Types.EvidenceDraft

/* ---------- 浏览器环境垫片 ---------- */

class LocalStorageShim {
  private m = new Map<string, string>()
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null
  }
  setItem(k: string, v: string) {
    this.m.set(k, v)
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
}

/** 极简 FileReader：仅支持导出用到的 readAsDataURL */
class FileReaderShim {
  result: string | null = null
  error: unknown = null
  onload: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  async readAsDataURL(blob: Blob) {
    try {
      const buf = Buffer.from(await blob.arrayBuffer())
      this.result = `data:${blob.type || ''};base64,${buf.toString('base64')}`
      this.onload?.({ target: this })
    } catch (e) {
      this.error = e
      this.onerror?.({ target: this })
    }
  }
}

let exportedJson: string | null = null
;(globalThis as any).window = {
  confirm: () => true,
  localStorage: new LocalStorageShim(),
  setTimeout: (fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => setTimeout(fn, ms, ...a),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage
;(globalThis as any).document = {
  createElement: () => ({
    href: '',
    download: '',
    click() {
      /* 导出拦截在 Blob 构造器处 */
    },
  }),
}
;(globalThis as any).URL = { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} }
;(globalThis as any).FileReader = FileReaderShim

// 拦截导出时 new Blob([json])，取出导出内容
const OrigBlob = globalThis.Blob
globalThis.Blob = class BlobSpy extends OrigBlob {
  constructor(parts: BlobPart[], options?: BlobPropertyBag) {
    super(parts, options)
    if (parts.length === 1 && typeof parts[0] === 'string' && parts[0].startsWith('{"app"')) {
      exportedJson = parts[0]
    }
  }
} as typeof Blob

/* ---------- 被测模块（垫片就绪后动态导入：store 模块加载即读取 localStorage） ---------- */

const {
  addRelation,
  addEvidence,
  clearAll,
  conflictCycles,
  conflictIds,
  evidenceBucket,
  evidenceStatus,
  exportProject,
  importProject,
  inferredEdges,
  loadSample,
  orderEdges,
  refresh,
  relationEffective,
  reviewEvidence,
  state,
  undoReview,
  setOperator,
  addUnit,
} = await import('../src/store')
const { reachablePairs } = await import('../src/graph')
type EvidenceDraft = import('../src/types').EvidenceDraft

let passed = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    passed++
    console.log(`  ✔ ${name}`)
  } catch (e) {
    console.error(`  ✘ ${name}`)
    console.error(e)
    process.exitCode = 1
  }
}

const pairs = (es: { from: string; to: string }[]) => es.map((e) => `${e.from}→${e.to}`).sort()
const effectivePairs = () => pairs(orderEdges.value)
const inferredPairs = () => pairs(inferredEdges.value)
const ev = (id: string) => state.evidences.find((e) => e.id === id)!
const rel = (id: string) => state.relations.find((r) => r.id === id)!
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

async function addSimpleEvidence(relationId: string, overrides: Partial<EvidenceDraft> = {}) {
  const id = await addEvidence(relationId, {
    type: 'diary',
    text: '测试证据',
    collectedAt: '2026-09-26',
    attachment: null,
    ...overrides,
  })
  return state.evidences.find((e) => e.id === id)!
}

/* ---------- 1. 示例基线：待复核/否决/冲突不进偏序，缺失附件有提示 ---------- */

await test('载入示例：R1~R6 有效，R8 混合证据被否决，R9 待复核，R10 成环冲突', async () => {
  await clearAll(false)
  await loadSample()

  assert.deepEqual(effectivePairs(), [
    '1003→1001',
    '1006→1005',
    '1007→1003',
    '1007→1006',
    '1010→1009',
    '1012→1010',
  ])
  // 待复核（R9）与未解决否决（R8）与已撤回（R11）均不生效
  assert.equal(relationEffective(rel('R8')), false)
  assert.equal(relationEffective(rel('R9')), false)
  assert.equal(rel('R11').status, 'retracted')

  // 采纳造成环：决定保留 + 生成冲突，冲突边不进偏序
  assert.deepEqual([...conflictIds.value], ['R10'])
  assert.equal(evidenceStatus('E10'), 'accepted')
  assert.deepEqual(conflictCycles.value.get('R10'), ['1009', '1012', '1010', '1009'])
  assert.equal(relationEffective(rel('R10')), false)

  // 缺失附件显式提示，但工程已加载
  assert.equal(state.loaded, true)
  assert.deepEqual(state.missingAttachments.map((e) => e.id), ['E1'])
  assert.ok(state.attachments['A2'], '存在的附件 A2 应可用')
})

/* ---------- 2. 待复核不影响矩阵 → 采纳生成新传递结论 → 撤销后消失 ---------- */

await test('R9(1005→1001) 采纳前无 1006→1001 推断；采纳后出现；撤销复核后消失', async () => {
  setOperator('测试员甲')
  assert.equal(evidenceStatus('E11'), 'pending')
  assert.ok(!inferredPairs().includes('1006→1001'), '待复核时不应有该传递结论')
  assert.ok(!effectivePairs().includes('1005→1001'))

  await reviewEvidence('E11', 'accepted', '照片冲洗后核对无误')

  assert.ok(effectivePairs().includes('1005→1001'), '采纳后观察边进入有效集')
  assert.ok(inferredPairs().includes('1006→1001'), '采纳后应产生新传递结论 1006→1001')
  assert.ok(inferredPairs().includes('1007→1001'))

  // 撤销最近一次复核：只能撤销、历史不删除（原采纳记录标记 undone + 追加一条撤销记录）
  const countAfterAccept = state.reviews.length
  await undoReview('E11')
  assert.equal(evidenceStatus('E11'), 'pending')
  assert.ok(!effectivePairs().includes('1005→1001'))
  assert.ok(!inferredPairs().includes('1006→1001'), '撤销后传递结论应消失')
  assert.equal(state.reviews.length, countAfterAccept + 1, '撤销是追加记录，原记录保留')
  assert.equal(state.reviews.find((v) => v.comment === '照片冲洗后核对无误')?.undone, true)
})

/* ---------- 3. 多证据混合状态 ---------- */

await test('R8：采纳+未解决驳回+待复核不生效；撤销驳回（仅剩采纳+待复核）即生效；重新驳回再次失效', async () => {
  const b0 = evidenceBucket('R8')
  assert.equal(b0.accepted.length, 1) // E8
  assert.equal(b0.rejected.length, 1) // E9
  assert.ok(!effectivePairs().includes('1009→1003'))
  assert.ok(!inferredPairs().includes('1010→1003'))

  // 撤销对 E9 的驳回 → E9 回到待复核；此时“至少一条采纳且无未解决否决”
  await undoReview('E9')
  assert.equal(evidenceStatus('E9'), 'pending')
  assert.ok(effectivePairs().includes('1009→1003'), '有采纳、无驳回、另有待复核 → 关系生效')
  assert.ok(inferredPairs().includes('1010→1003'), '生效后沿传递链生成新结论')
  assert.ok(inferredPairs().includes('1012→1003'))

  // 再次驳回 E9 → 未解决否决重新出现，关系与推断实时撤回
  await reviewEvidence('E9', 'rejected', '复核会维持反对意见')
  assert.ok(!effectivePairs().includes('1009→1003'))
  assert.ok(!inferredPairs().includes('1010→1003'))
})

/* ---------- 4. 干净数据上复现“采纳造成环” ---------- */

await test('全新数据：采纳 C→A 与 A→B→C 成环时保留采纳决定并生成冲突', async () => {
  await clearAll(false)
  setOperator('测试员乙')
  await addUnit('A', 'deposit', '')
  await addUnit('B', 'deposit', '')
  await addUnit('C', 'deposit', '')

  const idAB = (await addRelation({ from: 'A', to: 'B', kind: 'earlier', note: '' }))!
  const idBC = (await addRelation({ from: 'B', to: 'C', kind: 'earlier', note: '' }))!
  const idCA = (await addRelation({ from: 'C', to: 'A', kind: 'earlier', note: '' }))!

  // 全部待复核：矩阵为空
  assert.deepEqual(effectivePairs(), [])

  const eAB = await addSimpleEvidence(idAB)
  await tick()
  const eBC = await addSimpleEvidence(idBC)
  await tick()
  const eCA = await addSimpleEvidence(idCA)
  await reviewEvidence(eAB.id, 'accepted', '')
  await tick()
  await reviewEvidence(eBC.id, 'accepted', '')
  assert.deepEqual(effectivePairs(), ['A→B', 'B→C'])

  await tick()
  await reviewEvidence(eCA.id, 'accepted', '记录员坚持')
  // 决定没有被静默丢弃
  assert.equal(evidenceStatus(eCA.id), 'accepted')
  assert.equal(rel(idCA).status, 'active')
  assert.deepEqual([...conflictIds.value], [idCA])
  assert.deepEqual(conflictCycles.value.get(idCA), ['C', 'A', 'B', 'C'])
  // 冲突边不进偏序；闭包仍是无环的三条
  assert.deepEqual(reachablePairs(orderEdges.value), ['A→B', 'A→C', 'B→C'])
  assert.equal(relationEffective(rel(idCA)), false)

  // 撤销该采纳：冲突解除；证据回到待复核，仍不影响矩阵
  await undoReview(eCA.id)
  assert.equal(evidenceStatus(eCA.id), 'pending')
  assert.deepEqual([...conflictIds.value], [])
  assert.deepEqual(effectivePairs(), ['A→B', 'B→C'])
})

/* ---------- 5. 刷新 + 导出 + 重新导入：审计链/附件/计算一致 ---------- */

await test('刷新后状态一致；导出再导入：审计链、附件可用性、偏序闭包全部一致', async () => {
  await clearAll(false)
  await loadSample()
  const baselinePairs = effectivePairs()
  const baselineInferred = inferredPairs()
  const baselineReviews = state.reviews.map((v) => ({
    id: v.id,
    undone: v.undone,
    from: v.fromStatus,
    to: v.toStatus,
    op: v.operator,
  }))

  // 模拟浏览器刷新：全部状态从 IndexedDB 重读
  await refresh()
  assert.deepEqual(effectivePairs(), baselinePairs)
  assert.deepEqual(inferredPairs(), baselineInferred)
  assert.equal(evidenceStatus('E8'), 'accepted', '刷新后审计链重放：E8 经历驳回→撤销→采纳，仍为采纳')
  assert.equal(evidenceStatus('E9'), 'rejected')
  assert.equal(state.missingAttachments.length, 1)
  assert.equal(await (state.attachments['A2'] as Blob).text(), 'S-04 基槽剖面记录（示例附件）：1006 切穿 1007，槽内填土 1005。')

  // 真实导出路径（FileReader 垫片 + Blob 拦截）
  exportedJson = null
  await exportProject()
  assert.ok(exportedJson, '应产生导出 JSON')
  const exported = JSON.parse(exportedJson!)
  assert.equal(exported.version, 2)
  assert.equal(exported.reviews.length, 12)
  assert.equal(exported.attachments.length, 1, '仅 A2 有二进制；缺失的 A1 不阻断导出')
  assert.equal(exported.attachments[0].id, 'A2')
  const expectedOrder = reachablePairs(orderEdges.value)
  assert.deepEqual(exported.partialOrder, expectedOrder)

  // 清空后重新导入
  await clearAll(false)
  assert.equal(state.reviews.length, 0)
  const file = new File([exportedJson!], 'reimport.json', { type: 'application/json' })
  await importProject(file)

  // 审计链完整：撤销痕迹保留且状态重放一致
  assert.equal(state.reviews.length, baselineReviews.length)
  assert.deepEqual(
    state.reviews.map((v) => ({ id: v.id, undone: v.undone, from: v.fromStatus, to: v.toStatus, op: v.operator })),
    baselineReviews,
  )
  assert.equal(evidenceStatus('E8'), 'accepted')
  assert.equal(evidenceStatus('E9'), 'rejected')
  assert.equal(evidenceStatus('E10'), 'accepted')

  // 计算结果一致
  assert.deepEqual(effectivePairs(), baselinePairs)
  assert.deepEqual(inferredPairs(), baselineInferred)
  assert.deepEqual(reachablePairs(orderEdges.value), expectedOrder)
  assert.deepEqual([...conflictIds.value], ['R10'])

  // 附件：A2 恢复可用；A1 缺失被显式标注但不阻塞
  assert.equal(await (state.attachments['A2'] as Blob).text(), 'S-04 基槽剖面记录（示例附件）：1006 切穿 1007，槽内填土 1005。')
  assert.deepEqual(state.missingAttachments.map((e) => e.id), ['E1'])
  assert.ok(state.toast.includes('偏序校验一致'), `提示应说明校验一致，实际：${state.toast}`)
})

/* ---------- 6. v1 旧格式导入可迁移，附件损坏不拖垮工程 ---------- */

await test('导入 v1 工程（无 reviews/attachments 段）不报错，证据迁入待复核、关系不进偏序', async () => {
  const v1 = {
    app: 'harris-matrix-workbench',
    version: 1,
    exportedAt: new Date().toISOString(),
    units: [
      { id: 'u1', label: 'u1', type: 'deposit', note: '', createdAt: 1 },
      { id: 'u2', label: 'u2', type: 'deposit', note: '', createdAt: 2 },
    ],
    positions: [],
    relations: [
      { id: 'r1', from: 'u1', to: 'u2', kind: 'earlier', source: 'observation', status: 'active', conflict: false, evidenceIds: ['old-e'], note: '', createdAt: 1 },
    ],
    evidences: [{ id: 'old-e', ref: '旧日记', text: '旧版全局证据', createdAt: 1 }],
    retractions: [],
    partialOrder: ['u1→u2'],
  }
  const file = new File([JSON.stringify(v1)], 'v1.json', { type: 'application/json' })
  await importProject(file)
  assert.equal(state.evidences.length, 1)
  assert.equal(state.evidences[0].relationId, 'r1')
  assert.equal(evidenceStatus(state.evidences[0].id), 'pending', '迁移证据需重新走复核')
  assert.deepEqual(effectivePairs(), [], '待复核证据不影响矩阵')
  assert.equal(state.missingAttachments.length, 0)
})

console.log(`\n${passed} 组验收测试通过`)
