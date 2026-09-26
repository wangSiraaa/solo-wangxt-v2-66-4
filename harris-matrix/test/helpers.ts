import { File as NodeFile } from 'node:buffer'
import {
  addEvidence,
  addRelation,
  addUnit,
  clearAll,
  refresh,
  startReview,
  state,
  submitReview,
} from '../src/store'
import type { ProjectExport } from '../src/types'
import type { EvidenceType, RelationKind } from '../src/types'

/** 每个用例前清空内存库并重新装载响应式状态 */
export async function resetDb() {
  await clearAll(false)
  await refresh()
}

export async function makeUnits(labels: string[] = ['A', 'B', 'C', 'D']) {
  for (const l of labels) await addUnit(l, 'deposit', '')
  return labels
}

/** 登记一条「A 早于 B」的原始观察（无证据、待复核），返回关系 id */
export async function makeObservation(fromLabel: string, toLabel: string, kind: RelationKind = 'earlier') {
  await addRelation({
    from: findId(fromLabel),
    to: findId(toLabel),
    kind,
    source: 'observation',
    evidenceIds: [],
    note: '',
  })
  const rel = [...state.relations]
    .sort((a, b) => b.createdAt - a.createdAt)
    .find((r) => r.from === findId(fromLabel) && r.to === findId(toLabel) && r.kind === kind)!
  return rel.id
}

function findId(label: string) {
  return state.units.find((u) => u.label === label)!.id
}

export function unitId(label: string) {
  return findId(label)
}

export function relByEndpoints(fromLabel: string, toLabel: string) {
  return state.relations.find((r) => r.from === findId(fromLabel) && r.to === findId(toLabel))!
}

let seq = 0
/**
 * 构造 File：测试环境（happy-dom 的 File 无法被 fake-indexeddb 的 structuredClone 保留）
 * 下使用 Node 域的 File；生产浏览器中由 EvidenceReview 直接传入原生 File。
 */
export function makeFile(content: string, name: string, mime = 'text/plain'): File {
  return new NodeFile([content], name, { type: mime }) as unknown as File
}

export async function addPendingEvidence(
  relationId: string,
  type: EvidenceType = 'diary',
  file?: File | null,
  note = `证据-${++seq}`,
) {
  const day = '2026-09-25'
  await addEvidence({ relationId, type, note, collectedAt: day, file: file ?? null })
  const ev = [...state.evidences].sort((a, b) => b.createdAt - a.createdAt).find((e) => e.note === note)!
  return ev.id
}

export async function review(evidenceId: string, action: 'adopt' | 'reject', operator = '测试员甲', comment = '意见') {
  startReview(evidenceId, action)
  await submitReview(operator, comment)
}

export function pairsAsLabels(pairs: string[]): string[] {
  return pairs
    .map((p) => p.replace(/^inf:/, '').split('→'))
    .map(([f, t]) => `${labelOf(f)}→${labelOf(t)}`)
    .sort()
}

function labelOf(id: string) {
  return state.units.find((u) => u.id === id)?.label ?? id
}

/**
 * 截获导出点击：exportProject 会创建 blob URL 并触发锚点下载，
 * 这里把它重定向为直接读取 Blob 的 JSON 内容。
 */
export async function captureExportJson(
  exportFn: () => Promise<void> | void,
): Promise<ProjectExport> {
  const originalCreate = URL.createObjectURL
  const originalClick = HTMLAnchorElement.prototype.click
  let captured: Blob | null = null
  URL.createObjectURL = (obj: Blob | MediaSource) => {
    captured = obj as Blob
    return 'blob:captured'
  }
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    // 不真正下载
  }
  try {
    await exportFn()
  } finally {
    URL.createObjectURL = originalCreate
    HTMLAnchorElement.prototype.click = originalClick
  }
  return JSON.parse(await captured!.text())
}
