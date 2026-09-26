import { computed, reactive } from 'vue'
import { db } from './db'
import {
  layeredPositions,
  liveConflicts,
  reachablePairs,
  redundantEdges,
  transitiveInferences,
  type OrderEdge,
} from './graph'
import { isLegacyEvidence, migrateLegacy } from './migrate'
import { buildSample } from './sample'
import type {
  AttachmentBlob,
  AttachmentMeta,
  Batch,
  Evidence,
  EvidenceReviewStatus,
  EvidenceType,
  Mutation,
  ProjectExport,
  Relation,
  RelationDraft,
  Retraction,
  ReviewRecord,
  StratUnit,
  TableName,
  UnitPosition,
  UnitType,
} from './types'

export const state = reactive({
  loaded: false,
  units: [] as StratUnit[],
  positions: {} as Record<string, UnitPosition>,
  relations: [] as Relation[],
  evidences: [] as Evidence[],
  reviews: [] as ReviewRecord[],
  missingAttachmentIds: new Set<string>(),
  retractions: [] as Retraction[],
  batches: [] as Batch[],
  viewMode: 'raw' as 'raw' | 'simplified',
  selectedUnitId: null as string | null,
  /** 复核对话框：在某条证据上发起采纳/驳回 */
  pendingReview: null as { evidenceId: string; action: 'adopt' | 'reject' } | null,
  toast: '',
  /** 自增以通知画布重排（身份与位置分离，位置变化不触发数据刷新） */
  layoutVersion: 0,
})

/* ---------- 派生数据：证据复核状态 ---------- */

/** 审计链回放：按全局序号排序、跳过已撤销记录，最后一条决定证据当前状态 */
function byOrder(a: ReviewRecord, b: ReviewRecord): number {
  return (a.seq ?? 0) - (b.seq ?? 0)
}

export function statusOf(evidenceId: string): EvidenceReviewStatus {
  const chain = state.reviews
    .filter((r) => r.evidenceId === evidenceId && !r.undone)
    .sort(byOrder)
  return chain.length ? chain[chain.length - 1].toStatus : 'pending'
}

export function reviewsOf(evidenceId: string): ReviewRecord[] {
  return state.reviews.filter((r) => r.evidenceId === evidenceId).sort(byOrder)
}

/** 最近一次仍生效的复核（全局）：决定“撤销最近一次复核”按钮是否可用 */
export const lastReview = computed<ReviewRecord | null>(() => {
  const live = state.reviews.filter((r) => !r.undone)
  if (live.length === 0) return null
  return [...live].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))[0]
})

export function evidenceOfRelation(relationId: string): Evidence[] {
  return state.evidences
    .filter((e) => e.relationId === relationId)
    .sort((a, b) => a.createdAt - b.createdAt)
}

export const evidenceById = (id: string): Evidence | undefined => state.evidences.find((e) => e.id === id)

/* ---------- 派生数据：有效观察集与偏序计算 ---------- */

/**
 * 有效门槛：一条活跃观察关系，当且仅当
 *   至少一条证据「已采纳」且没有任何「未解决否决」（已驳回且之后未再采纳）
 * 才允许进入有效偏序计算。同期关联与旧版手填推断都不进入此门槛。
 */
export type GateState = 'valid' | 'pending' | 'rejected'

export function gateState(rel: Relation): GateState {
  if (rel.status !== 'active' || rel.source !== 'observation') return 'pending'
  const list = evidenceOfRelation(rel.id)
  if (list.length === 0) return 'pending'
  const statuses = list.map((e) => statusOf(e.id))
  if (!statuses.includes('accepted')) return 'pending'
  if (statuses.includes('rejected')) return 'rejected'
  return 'valid'
}

export const activeRelations = computed(() => state.relations.filter((r) => r.status === 'active'))

/** 有效观察关系（通过复核门槛）；推断关系随此集合实时重算 */
export const effectiveObservations = computed<Relation[]>(() =>
  activeRelations.value.filter((r) => r.kind === 'earlier' && gateState(r) === 'valid'),
)

function toEdge(r: Relation): OrderEdge {
  return { id: r.id, from: r.from, to: r.to }
}

const effectiveEdges = computed<OrderEdge[]>(() => effectiveObservations.value.map(toEdge))

/** 当前有效观察集下的实时冲突：冲突边 id → 完整环路径（采纳时判定，随否决自动解除） */
export const conflictInfo = computed<Map<string, string[]>>(() => liveConflicts(effectiveEdges.value))

/** 无冲突的有效观察边：偏序与推断计算只在这个 DAG 上进行；冲突边保留但不参与计算 */
export const orderEdges = computed<OrderEdge[]>(() =>
  effectiveEdges.value.filter((e) => !conflictInfo.value.has(e.id)),
)

/** 推断关系：有效观察闭包中距离 ≥2 且无直接观察边的有序对，实时导出 */
export const inferredEdges = computed<OrderEdge[]>(() => transitiveInferences(orderEdges.value))

/** 画布上的全部有向边：有效观察 + 实时推断（冲突边保留为红边） */
export const matrixEdges = computed<OrderEdge[]>(() => [
  ...effectiveEdges.value,
  ...inferredEdges.value,
])

/** 简化视图要隐藏的传递冗余边（只隐藏，不删除）；推断边在简化视图下全部隐藏 */
export const redundantIds = computed(() => {
  const red = redundantEdges(matrixEdges.value)
  for (const e of inferredEdges.value) red.add(e.id)
  return red
})

export const lastBatch = computed(() => {
  for (let i = state.batches.length - 1; i >= 0; i--) {
    if (!state.batches[i].undone) return state.batches[i]
  }
  return null
})

export function unitLabel(id: string): string {
  return state.units.find((u) => u.id === id)?.label ?? id
}

/* ---------- 基础工具 ---------- */

const uid = () => crypto.randomUUID()

/**
 * 单调创建时间：同一毫秒内连续登记多条关系/证据时，Date.now 会相同，
 * 若仅按它排序，liveConflicts 的逐条接受次序不确定（环会随机落在不同边上）。
 * 该函数保证返回值在本会话内严格递增（不小于真实墙上时间）。
 */
let monotonicNow = 0
function stamp(): number {
  monotonicNow = Math.max(monotonicNow + 1, Date.now())
  return monotonicNow
}

/**
 * 全局复核序：审计链的先后必须与「数据进入本机的顺序」一致，不能依赖墙上时间
 * （导入/示例携带的 at 可能晚于此后新建的记录）。载入后按 (at, 原 seq) 重排
 * 并统一重新编号，之后新提交的复核序号续增，撤销与「最近一次」因此严格确定。
 */
let reviewSeq = 0
function reseedReviewOrder(existing: ReviewRecord[]): ReviewRecord[] {
  const ordered = [...existing].sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0))
  ordered.forEach((r, i) => (r.seq = i + 1))
  reviewSeq = ordered.length
  return ordered
}

let toastTimer = 0
export function toast(msg: string) {
  state.toast = msg
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (state.toast = ''), 6000)
}

function tableOf(name: TableName) {
  return {
    units: db.units,
    positions: db.positions,
    relations: db.relations,
    evidences: db.evidences,
    retractions: db.retractions,
    reviews: db.reviews,
    attachments: db.attachments,
  }[name]
}

/** 写入 IndexedDB 前去除 Vue 响应式代理（structuredClone 无法克隆 Proxy） */
function plain<T>(v: T): T {
  return v == null ? v : (JSON.parse(JSON.stringify(v)) as T)
}

/**
 * 附件行含 Uint8Array，必须原值写入：JSON 克隆会把它退化成普通对象，
 * 且 Vue 代理对二进制行没有意义。其余行去除代理后写入。
 */
async function putRow(table: TableName, key: string, row: unknown) {
  const t = tableOf(table)
  if (row == null) {
    await t.delete(key)
  } else if (table === 'attachments') {
    await t.put(row as never)
  } else {
    await t.put(plain(row) as never)
  }
}

function asAttachmentRow(id: string, file: Blob, bytes: Uint8Array): AttachmentBlob {
  const name = file instanceof File ? file.name : 'attachment'
  return { id, bytes, mime: file.type || 'application/octet-stream', name }
}

async function applyForward(m: Mutation) {
  await putRow(m.table, m.key, m.after)
}

async function applyInverse(m: Mutation) {
  await putRow(m.table, m.key, m.before)
}

/** 扫描元数据声明了但 Blob 已缺失的附件（缺失只提示，绝不让工程无法加载） */
async function computeMissingAttachments(evidences: Evidence[]): Promise<Set<string>> {
  const missing = new Set<string>()
  const ids = evidences.map((e) => e.attachment?.id).filter((x): x is string => !!x)
  if (ids.length === 0) return missing
  const have = new Set(await db.attachments.bulkGet(ids).then((rows) => rows.filter(Boolean).map((r) => r!.id)))
  for (const e of evidences) {
    if (e.attachment && !have.has(e.attachment.id)) missing.add(e.id)
  }
  return missing
}

/**
 * 关系/证据的创建顺序：createdAt 同毫秒时用 id 兜底，保证列表顺序与
 * liveConflicts 的逐条接受次序完全确定（否则环会随机落在不同边上）。
 */
function byCreation<T extends { createdAt: number; id: string }>(a: T, b: T): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export async function refresh() {
  const [units, positions, relations, rawEvidences, reviews, retractions, batches] = await Promise.all([
    db.units.toArray(),
    db.positions.toArray(),
    db.relations.toArray(),
    db.evidences.toArray(),
    db.reviews.toArray(),
    db.retractions.toArray(),
    db.batches.orderBy('at').toArray(),
  ])

  // 旧版（v1）证据惰性迁移：补齐归属/类型/采集日期，并写入显式「迁移采纳」审计
  let evidences = rawEvidences
  if (rawEvidences.some((e) => isLegacyEvidence(e))) {
    const mig = migrateLegacy(rawEvidences, relations)
    await db.transaction('rw', [db.evidences, db.reviews], async () => {
      for (const e of mig.evidences) await db.evidences.put(e)
      for (const r of mig.reviews) await db.reviews.put(r)
    })
    evidences = mig.evidences
    reviews.push(...mig.reviews)
  }

  // 统一审计序号（幂等）：导入/迁移后也能保证全局顺序与本机后续提交连续
  const orderedReviews = reseedReviewOrder(reviews)
  let orderChanged = reviews.some((r, i) => orderedReviews[i] !== r)
  const byId = new Map(orderedReviews.map((r) => [r.id, r]))
  for (const original of reviews) {
    if (byId.get(original.id)!.seq !== (original.seq ?? 0)) orderChanged = true
  }
  if (orderChanged) {
    await db.transaction('rw', [db.reviews], async () => {
      for (const r of orderedReviews) await db.reviews.put(r)
    })
  }

  const missing = await computeMissingAttachments(evidences)

  state.units = units.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  state.positions = Object.fromEntries(positions.map((p) => [p.unitId, p]))
  state.relations = relations.sort(byCreation)
  state.evidences = evidences.sort(byCreation)
  state.reviews = orderedReviews
  // 已载入（含导入）数据中最晚的创建时间之后继续发号，保证新记录严格排尾
  monotonicNow = Math.max(
    ...state.relations.map((r) => r.createdAt),
    ...state.evidences.map((e) => e.createdAt),
    Date.now() - 1,
  )
  state.missingAttachmentIds = missing
  state.retractions = retractions.sort((a, b) => a.at - b.at)
  state.batches = batches
  state.loaded = true
}

/** 以批次执行一组变更：全部正向应用后登记批次，供整体撤销 */
async function runBatch(label: string, mutations: Mutation[]) {
  if (mutations.length === 0) return
  for (const m of mutations) await applyForward(m)
  const batch: Batch = { id: uid(), label, at: Date.now(), undone: false, mutations }
  await db.batches.put(plain(batch))
  await refresh()
}

/** 撤销最近一个未撤销的批次：关系与证据引用随逆向变更一起恢复（审计链不参与批次） */
export async function undo() {
  const batch = [...state.batches].reverse().find((b) => !b.undone)
  if (!batch) {
    toast('没有可撤销的操作')
    return
  }
  for (const m of [...batch.mutations].reverse()) await applyInverse(m)
  await db.batches.update(batch.id, { undone: true })
  await refresh()
  toast(`已撤销：${batch.label}`)
}

/* ---------- 层位 ---------- */

export async function addUnit(label: string, type: UnitType, note: string) {
  label = label.trim()
  if (!label) return
  if (state.units.some((u) => u.label === label)) {
    toast(`层位 ${label} 已存在`)
    return
  }
  const unit: StratUnit = { id: uid(), label, type, note: note.trim(), createdAt: stamp() }
  await runBatch(`新增层位 ${label}`, [{ table: 'units', key: unit.id, before: null, after: unit }])
  toast(`已新增层位 ${label}`)
}

export async function deleteUnit(id: string) {
  const unit = state.units.find((u) => u.id === id)
  if (!unit) return
  const mutations: Mutation[] = [{ table: 'units', key: id, before: unit, after: null }]
  const pos = state.positions[id]
  if (pos) mutations.push({ table: 'positions', key: id, before: pos, after: null })
  // 连带删除涉及该层位的关系、其证据与附件、撤销记录（全部记入批次，可整体撤销）
  for (const r of state.relations.filter((r) => r.from === id || r.to === id)) {
    mutations.push({ table: 'relations', key: r.id, before: r, after: null })
    for (const x of state.retractions.filter((x) => x.relationId === r.id)) {
      mutations.push({ table: 'retractions', key: x.id, before: x, after: null })
    }
    for (const e of state.evidences.filter((e) => e.relationId === r.id)) {
      mutations.push({ table: 'evidences', key: e.id, before: e, after: null })
      if (e.attachment) {
        const row = await db.attachments.get(e.attachment.id)
        if (row) mutations.push({ table: 'attachments', key: e.attachment.id, before: row, after: null })
      }
    }
  }
  await runBatch(`删除层位 ${unit.label}（连带 ${mutations.length} 项记录）`, mutations)
  if (state.selectedUnitId === id) state.selectedUnitId = null
  toast(`已删除层位 ${unit.label}`)
}

/* ---------- 证据（附属于原始观察关系，可挂附件） ---------- */

export interface NewEvidence {
  relationId: string
  type: EvidenceType
  note: string
  collectedAt: string
  file?: File | null
}

/**
 * 新增证据：状态恒为「待复核」，不影响矩阵；附件二进制独立存入 attachments 表。
 */
export async function addEvidence(input: NewEvidence) {
  const rel = state.relations.find((r) => r.id === input.relationId)
  if (!rel) return
  const note = input.note.trim()
  const collectedAt = input.collectedAt || new Date().toISOString().slice(0, 10)

  let attachment: AttachmentMeta | null = null
  let blobRow: AttachmentBlob | null = null
  if (input.file) {
    attachment = {
      id: uid(),
      name: input.file.name,
      mime: input.file.type || 'application/octet-stream',
      size: input.file.size,
    }
    blobRow = asAttachmentRow(attachment.id, input.file, new Uint8Array(await input.file.arrayBuffer()))
  }

  const ev: Evidence = {
    id: uid(),
    relationId: input.relationId,
    type: input.type,
    note,
    collectedAt,
    attachment,
    createdAt: stamp(),
  }
  const mutations: Mutation[] = [{ table: 'evidences', key: ev.id, before: null, after: ev }]
  if (blobRow) mutations.push({ table: 'attachments', key: blobRow.id, before: null, after: blobRow })
  await runBatch(
    `为 ${unitLabel(rel.from)}→${unitLabel(rel.to)} 登记${attachment ? '带附件' : ''}证据（待复核）`,
    mutations,
  )
  toast('证据已登记，状态为「待复核」，在采纳前不影响矩阵')
}

/** 读取附件为 Blob（缺失返回 null，由界面显式提示） */
export async function getAttachmentBlob(meta: AttachmentMeta): Promise<Blob | null> {
  const row = await db.attachments.get(meta.id)
  return row ? new Blob([row.bytes], { type: row.mime || meta.mime }) : null
}

export async function downloadEvidenceAttachment(ev: Evidence) {
  if (!ev.attachment) return
  const blob = await getAttachmentBlob(ev.attachment)
  if (!blob) {
    toast(`附件「${ev.attachment.name}」在本机缺失，无法打开（可重新登记附件）`)
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = ev.attachment.name
  a.click()
  URL.revokeObjectURL(url)
}

/* ---------- 复核闭环（审计链只追加；撤销只标记不删除） ---------- */

/** 发起复核（弹出对话框收集操作者与意见） */
export function startReview(evidenceId: string, action: 'adopt' | 'reject') {
  state.pendingReview = { evidenceId, action }
}

export function cancelReview() {
  state.pendingReview = null
}

/**
 * 提交复核：记录操作者、时间、意见与前后状态。
 * 采纳后若该关系因此进入有效集并构成环，复核决定照样保留，
 * 由 conflictInfo 实时标红并给出环路径（冲突而非静默丢弃）。
 */
export async function submitReview(operator: string, comment: string) {
  const pending = state.pendingReview
  if (!pending) return
  const ev = state.evidences.find((e) => e.id === pending.evidenceId)
  if (!ev) {
    state.pendingReview = null
    return
  }
  const fromStatus = statusOf(ev.id)
  const toStatus: EvidenceReviewStatus = pending.action === 'adopt' ? 'accepted' : 'rejected'
  const op = operator.trim() || '匿名记录员'
  const record: ReviewRecord = {
    id: uid(),
    seq: ++reviewSeq,
    evidenceId: ev.id,
    action: pending.action,
    operator: op,
    comment: comment.trim() || '（未填写意见）',
    at: Date.now(),
    fromStatus,
    toStatus,
    undone: false,
  }
  state.pendingReview = null
  await db.reviews.put(plain(record))
  await refresh()

  const rel = state.relations.find((r) => r.id === ev.relationId)
  const cycle = rel ? conflictInfo.value.get(rel.id) : undefined
  if (cycle) {
    toast(
      `已采纳并保留该证据，但关系 ${unitLabel(rel!.from)}→${unitLabel(rel!.to)} 构成环冲突：` +
        [...cycle].map(unitLabel).join(' → ') + '（见画布红边，不丢弃任何记录）',
    )
  } else {
    toast(pending.action === 'adopt' ? `已采纳（${op}），矩阵已实时重算` : `已驳回（${op}），矩阵已实时重算`)
  }
}

/**
 * 撤销最近一次复核：将该审计记录标记 undone，决定回滚到上一状态，
 * 历史记录仍然保留（不能删除历史）。
 */
export async function undoReview() {
  const record = lastReview.value
  if (!record) {
    toast('没有可撤销的复核')
    return
  }
  await db.reviews.update(record.id, { undone: true })
  await refresh()
  const ev = state.evidences.find((e) => e.id === record.evidenceId)
  toast(
    `已撤销 ${record.operator} 的${record.action === 'adopt' ? '采纳' : '驳回'}复核` +
      (ev ? `，证据回到「${statusOf(ev.id) === 'pending' ? '待复核' : statusOf(ev.id) === 'accepted' ? '已采纳' : '已驳回'}」` : '') +
      '（审计记录保留）',
  )
}

/* ---------- 关系 ---------- */

function describe(draft: RelationDraft | Relation): string {
  return draft.kind === 'earlier'
    ? `${unitLabel(draft.from)} 早于 ${unitLabel(draft.to)}`
    : `${unitLabel(draft.from)} 与 ${unitLabel(draft.to)} 同期`
}

/**
 * 新增原始观察关系。登记时不做环检测——关系在证据复核通过前不进入矩阵；
 * 成环与否在采纳时由 liveConflicts 实时判定（保留决定 + 标冲突）。
 */
export async function addRelation(draft: RelationDraft) {
  if (!draft.from || !draft.to) return
  if (draft.kind === 'earlier' && draft.from === draft.to) {
    toast('层位不能早于其自身')
    return
  }
  const dup = activeRelations.value.some(
    (r) => r.from === draft.from && r.to === draft.to && r.kind === draft.kind,
  )
  if (dup) {
    toast('相同的关系已存在')
    return
  }
  const relation: Relation = {
    id: uid(),
    from: draft.from,
    to: draft.to,
    kind: draft.kind,
    // 界面只允许登记原始观察；推断关系由有效观察集实时导出
    source: 'observation',
    status: 'active',
    conflict: false,
    evidenceIds: [],
    note: draft.note.trim(),
    createdAt: stamp(),
  }
  await runBatch(`新增原始观察：${describe(relation)}`, [
    { table: 'relations', key: relation.id, before: null, after: relation },
  ])
  toast('已登记原始观察，请为其添加证据并完成复核（采纳前不影响矩阵）')
}

/** 撤回判断：关系标记为 retracted，快照与理由单独存入 retractions 表 */
export async function retractRelation(id: string, reason: string) {
  const rel = state.relations.find((r) => r.id === id)
  if (!rel || rel.status !== 'active') return
  const retraction: Retraction = {
    id: uid(),
    relationId: id,
    snapshot: { ...rel },
    reason: reason.trim() || '（未填写理由）',
    at: Date.now(),
  }
  await runBatch(`撤回判断：${describe(rel)}`, [
    { table: 'relations', key: id, before: rel, after: { ...rel, status: 'retracted' as const } },
    { table: 'retractions', key: retraction.id, before: null, after: retraction },
  ])
  toast('已撤回，判断与理由已单独存档')
}

/* ---------- 画布位置（与地层身份分离，不进入撤销批次） ---------- */

export async function savePosition(unitId: string, x: number, y: number) {
  const pos: UnitPosition = { unitId, x, y }
  await db.positions.put(pos)
  state.positions = { ...state.positions, [unitId]: pos }
}

/** 按最长路径分层自动排布（仅依据无冲突的有效观察边） */
export async function autoLayout() {
  const auto = layeredPositions(
    state.units.map((u) => u.id),
    orderEdges.value,
  )
  for (const [id, p] of auto) await db.positions.put({ unitId: id, x: p.x, y: p.y })
  await refresh()
  state.layoutVersion++
  toast('已按有效观察的地层早晚自动分层排布')
}

/* ---------- 示例 / 清空 / 导出 / 导入 ---------- */

export async function loadSample() {
  if (state.units.length > 0 && !window.confirm('载入示例将先清空当前工程（不可撤销），继续？')) return
  await clearAll(false)
  const now = Date.now()
  const sample = buildSample(now)
  const positions = layeredPositions(
    sample.units.map((u) => u.id),
    sample.relations
      .filter((r) => r.kind === 'earlier' && r.source === 'observation')
      .filter((r) => {
        const evs = sample.evidences.filter((e) => e.relationId === r.id)
        const accepted = evs.some((e) => sample.reviews.some((v) => v.evidenceId === e.id && !v.undone && v.toStatus === 'accepted'))
        const rejected = evs.some((e) => sample.reviews.some((v) => v.evidenceId === e.id && !v.undone && v.toStatus === 'rejected'))
        return accepted && !rejected
      })
      .map(toEdge),
  )
  const mutations: Mutation[] = []
  for (const u of sample.units) mutations.push({ table: 'units', key: u.id, before: null, after: u })
  for (const e of sample.evidences) mutations.push({ table: 'evidences', key: e.id, before: null, after: e })
  for (const r of sample.reviews) mutations.push({ table: 'reviews', key: r.id, before: null, after: r })
  for (const r of sample.relations) mutations.push({ table: 'relations', key: r.id, before: null, after: r })
  for (const x of sample.retractions) mutations.push({ table: 'retractions', key: x.id, before: null, after: x })
  for (const a of sample.attachments) mutations.push({ table: 'attachments', key: a.id, before: null, after: a })
  for (const u of sample.units) {
    const p = positions.get(u.id)
    if (p) mutations.push({ table: 'positions', key: u.id, before: null, after: { unitId: u.id, ...p } })
  }
  await runBatch('载入示例工程', mutations)
  state.layoutVersion++
  toast('示例工程已载入（含复核采纳/驳回、成环冲突、撤销的复核、缺失附件提示与旧版推断存档）')
}

const ALL_TABLES = [
  db.units,
  db.positions,
  db.relations,
  db.evidences,
  db.reviews,
  db.attachments,
  db.retractions,
  db.batches,
] as const

export async function clearAll(confirm = true) {
  if (confirm && !window.confirm('清空全部工程数据？此操作不可撤销。')) return
  await db.transaction('rw', ALL_TABLES, async () => {
    await Promise.all([
      db.units.clear(),
      db.positions.clear(),
      db.relations.clear(),
      db.evidences.clear(),
      db.reviews.clear(),
      db.attachments.clear(),
      db.retractions.clear(),
      db.batches.clear(),
    ])
  })
  state.selectedUnitId = null
  await refresh()
  if (confirm) toast('工程已清空')
}

/* ---------- 导出 / 导入：审计链、附件与计算结果一并保持一致 ---------- */

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export async function exportProject() {
  // 附件内容以 data URL 随工程导出，保证重新导入后仍可打开
  const rows = await db.attachments.bulkGet(
    state.evidences.map((e) => e.attachment?.id).filter((x): x is string => !!x),
  )
  const blobById = new Map<string, AttachmentBlob>()
  for (const row of rows) if (row) blobById.set(row.id, row)
  const attachments = []
  for (const ev of state.evidences) {
    if (!ev.attachment) continue
    const row = blobById.get(ev.attachment.id)
    if (!row) continue // 缺失附件只导出元数据（在证据上），导入端会继续提示
    attachments.push({
      id: row.id,
      name: row.name,
      mime: row.mime,
      size: row.bytes.byteLength,
      dataUrl: `data:${row.mime || 'application/octet-stream'};base64,${bytesToBase64(row.bytes)}`,
    })
  }

  const data: ProjectExport = {
    app: 'harris-matrix-workbench',
    version: 2,
    exportedAt: new Date().toISOString(),
    units: plain(state.units),
    positions: Object.values(state.positions),
    relations: plain(state.relations),
    evidences: plain(state.evidences),
    reviews: plain(state.reviews),
    attachments,
    retractions: plain(state.retractions),
    // 偏序闭包只由「无冲突的有效观察」计算
    partialOrder: reachablePairs(orderEdges.value),
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `harris-matrix-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
  const missingCount = state.missingAttachmentIds.size
  toast(
    `已导出（偏序闭包 ${data.partialOrder.length} 个可达对，复核记录 ${data.reviews.length} 条，附件 ${attachments.length} 个` +
      (missingCount ? `，${missingCount} 个附件本机缺失未包含` : '') + '）',
  )
}

interface ParsedProject {
  units: StratUnit[]
  positions: UnitPosition[]
  relations: Relation[]
  evidences: Evidence[]
  reviews: ReviewRecord[]
  retractions: Retraction[]
  attachmentRows: AttachmentBlob[]
  partialOrder: string[]
}

async function parseProject(raw: unknown): Promise<ParsedProject | { error: string }> {
  const data = raw as {
    app?: string
    version?: number
    units?: StratUnit[]
    positions?: UnitPosition[]
    relations?: Relation[]
    evidences?: unknown[]
    reviews?: ReviewRecord[]
    attachments?: Array<AttachmentMeta & { dataUrl?: string }>
    retractions?: Retraction[]
    partialOrder?: string[]
  }
  if (data?.app !== 'harris-matrix-workbench' || !Array.isArray(data.units) || !Array.isArray(data.relations)) {
    return { error: '文件格式不符' }
  }
  const relations = data.relations
  let evidences: Evidence[] = (data.evidences ?? []) as Evidence[]

  // v1 工程：旧证据在导入时迁移，并补齐显式采纳审计
  let reviews = data.reviews ?? []
  if ((data.version ?? 1) < 2 || evidences.some((e) => isLegacyEvidence(e))) {
    const mig = migrateLegacy(evidences, relations)
    evidences = mig.evidences
    reviews = [...reviews, ...mig.reviews]
  }

  // v2 附件：data URL 还原为字节；缺失内容（v1 无此字段 / 数据损坏）不阻断加载
  const attachmentRows: AttachmentBlob[] = []
  for (const a of data.attachments ?? []) {
    if (!a.id || !a.dataUrl) continue
    try {
      const [head, b64] = a.dataUrl.split(',')
      const mime = /data:([^;]*)/.exec(head)?.[1] || a.mime || 'application/octet-stream'
      const bin = atob(b64 ?? '')
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      attachmentRows.push({ id: a.id, name: a.name || 'attachment', mime, bytes })
    } catch {
      /* 内容损坏：跳过 Blob，元数据保留，刷新后进入缺失提示 */
    }
  }

  return {
    units: data.units,
    positions: data.positions ?? [],
    relations,
    evidences,
    reviews,
    retractions: data.retractions ?? [],
    attachmentRows,
    partialOrder: data.partialOrder ?? [],
  }
}

export async function importProject(file: File) {
  let raw: unknown
  try {
    raw = JSON.parse(await file.text())
  } catch {
    toast('导入失败：不是有效的 JSON 文件')
    return
  }
  const parsed = await parseProject(raw)
  if ('error' in parsed) {
    toast(`导入失败：${parsed.error}`)
    return
  }
  if (!window.confirm('导入将替换当前工程（不可撤销），继续？')) return
  await db.transaction('rw', ALL_TABLES, async () => {
    await Promise.all([
      db.units.clear(),
      db.positions.clear(),
      db.relations.clear(),
      db.evidences.clear(),
      db.reviews.clear(),
      db.attachments.clear(),
      db.retractions.clear(),
      db.batches.clear(),
    ])
    await db.units.bulkPut(plain(parsed.units))
    await db.positions.bulkPut(plain(parsed.positions))
    await db.relations.bulkPut(plain(parsed.relations))
    await db.evidences.bulkPut(plain(parsed.evidences))
    await db.reviews.bulkPut(plain(parsed.reviews))
    await db.retractions.bulkPut(plain(parsed.retractions))
    // 附件含 Uint8Array，不能走 JSON 克隆，按原值写入
    for (const a of parsed.attachmentRows) await db.attachments.put(a)
  })
  await refresh()
  state.layoutVersion++

  // 偏序一致性校验：导入后重算可达对并与导出快照比对
  const expected = [...parsed.partialOrder].sort()
  const actual = reachablePairs(orderEdges.value)
  const missing = state.missingAttachmentIds.size
  const base =
    JSON.stringify(expected) === JSON.stringify(actual)
      ? `导入完成，偏序校验一致（${actual.length} 个可达对）`
      : '导入完成，但偏序与导出时不一致，请检查数据'
  toast(base + (missing ? `；另有 ${missing} 个附件在本机缺失，请在证据列表中查看提示` : ''))
}
