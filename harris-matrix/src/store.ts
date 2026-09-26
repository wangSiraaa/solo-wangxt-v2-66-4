import { computed, markRaw, reactive } from 'vue'
import { db } from './db'
import {
  conflictSplit,
  inferredConclusions,
  layeredPositions,
  reachablePairs,
  redundantEdges,
  type OrderEdge,
} from './graph'
import { buildSample, sampleEffectiveEdges } from './sample'
import type {
  AttachmentBlob,
  Batch,
  Evidence,
  EvidenceDraft,
  EvidenceType,
  Mutation,
  ProjectExport,
  Relation,
  RelationDraft,
  Retraction,
  Review,
  ReviewStatus,
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
  retractions: [] as Retraction[],
  reviews: [] as Review[],
  /** 附件二进制映射 id → Blob（内容仍只存在浏览器本地） */
  attachments: {} as Record<string, Blob>,
  batches: [] as Batch[],
  viewMode: 'raw' as 'raw' | 'simplified',
  selectedUnitId: null as string | null,
  /** 证据声明了附件但本地找不到二进制：显式提示，但不阻塞工程加载 */
  missingAttachments: [] as Evidence[],
  toast: '',
  /** 自增以通知画布重排（身份与位置分离，位置变化不触发数据刷新） */
  layoutVersion: 0,
  /** 当前操作者名称（记录进每条复核审计），持久化于 localStorage */
  operator: localStorage.getItem('hm-operator') ?? '',
})

/* ---------- 派生数据 ---------- */

export const activeRelations = computed(() => state.relations.filter((r) => r.status === 'active'))

/** 一条证据的当前复核状态：审计链中该证据最后一条未撤销决定；缺省为待复核 */
export function evidenceStatus(evId: string): ReviewStatus {
  let s: ReviewStatus = 'pending'
  for (const rv of state.reviews) {
    if (rv.evidenceId === evId && !rv.undone) s = rv.toStatus
  }
  return s
}

export function evidenceOf(relationId: string): Evidence[] {
  return state.evidences.filter((e) => e.relationId === relationId)
}

/** 关系上的证据按当前复核状态分桶 */
export function evidenceBucket(relationId: string): {
  accepted: Evidence[]
  rejected: Evidence[]
  pending: Evidence[]
} {
  const accepted: Evidence[] = []
  const rejected: Evidence[] = []
  const pending: Evidence[] = []
  for (const e of evidenceOf(relationId)) {
    const s = evidenceStatus(e.id)
    if (s === 'accepted') accepted.push(e)
    else if (s === 'rejected') rejected.push(e)
    else pending.push(e)
  }
  return { accepted, rejected, pending }
}

/**
 * 关系是否通过证据闸门：至少一条已采纳证据，且没有未解决否决（已驳回）。
 * 待复核证据既不激活也不算否决。
 */
export function evidenceGatePasses(relationId: string): boolean {
  const b = evidenceBucket(relationId)
  return b.accepted.length > 0 && b.rejected.length === 0
}

/** 通过证据闸门的活跃“早于”观察关系（可能成环，成环者再由冲突分析剔除） */
export const gatedObservationRelations = computed(() =>
  activeRelations.value.filter(
    (r) => r.kind === 'earlier' && r.source === 'observation' && evidenceGatePasses(r.id),
  ),
)

/** 每条通过闸门的观察边，其最后一次有效采纳的时间（用于成环时确定“后加入”的冲突边） */
function acceptedAt(relationId: string): number {
  let t = 0
  for (const e of evidenceOf(relationId)) {
    let lastAccepted = 0
    for (const v of state.reviews) {
      if (v.evidenceId === e.id && !v.undone && v.toStatus === 'accepted') lastAccepted = v.at
    }
    if (lastAccepted > t) t = lastAccepted
  }
  return t
}

const gatedEdges = computed<OrderEdge[]>(() =>
  gatedObservationRelations.value
    // 确定性次序：采纳时间为主、关系创建时间与 id 兜底，避免同毫秒成环时结论随机
    .map((r) => ({ id: r.id, from: r.from, to: r.to, _at: acceptedAt(r.id), _created: r.createdAt }))
    .sort((a, b) => a._at - b._at || a._created - b._created || (a.id < b.id ? -1 : 1))
    .map(({ id, from, to }) => ({ id, from, to })),
)

/** 冲突分析：保留全部复核决定，成环边标冲突并排除出偏序 */
const analysis = computed(() => conflictSplit(gatedEdges.value))

/** 有效观察边：通过证据闸门且不成环 —— 偏序计算只用这组边 */
export const orderEdges = computed<OrderEdge[]>(() => analysis.value.skeleton)

/** 当前成环冲突关系集合（采纳决定被保留，仅不参与偏序） */
export const conflictIds = computed(() => analysis.value.conflictIds)
export const conflictCycles = computed(() => analysis.value.cycles)

export function isConflict(relationId: string): boolean {
  return analysis.value.conflictIds.has(relationId)
}

/** 推断关系：有效观察偏序闭包中不由观察直接给出的可达对，随证据复核实时重算 */
export const inferredEdges = computed(() => inferredConclusions(orderEdges.value))

/** 同期关联（仍需通过证据闸门才在矩阵上显示） */
export const activeContemporary = computed(() =>
  activeRelations.value.filter((r) => r.kind === 'contemporary' && evidenceGatePasses(r.id)),
)

/** 未通过证据闸门 / 已撤回的关系，不进入矩阵 */
export function relationEffective(r: Relation): boolean {
  if (r.status !== 'active' || !evidenceGatePasses(r.id)) return false
  if (r.kind === 'earlier' && r.source === 'observation') return !isConflict(r.id)
  return true
}

/** 简化视图要隐藏的传递冗余边（只隐藏，不删除）——只作用于有效观察边 */
export const redundantIds = computed(() => redundantEdges(orderEdges.value))

/** 历史推断记录（v1 手工推断）：只存档显示，不参与偏序（推断已改为实时派生） */
export const legacyInferenceRelations = computed(() =>
  state.relations.filter((r) => r.source === 'inference'),
)

export const lastBatch = computed(() => {
  for (let i = state.batches.length - 1; i >= 0; i--) {
    if (!state.batches[i].undone) return state.batches[i]
  }
  return null
})

export const activeReviews = computed(() => state.reviews.filter((r) => !r.undone))

export function unitLabel(id: string): string {
  return state.units.find((u) => u.id === id)?.label ?? id
}

export const evidenceTypeNames: Record<EvidenceType, string> = {
  diary: '田野日记',
  photo: '照片',
  section: '剖面图',
  card: '地层卡',
  other: '其他',
}

export const reviewStatusNames: Record<ReviewStatus, string> = {
  pending: '待复核',
  accepted: '已采纳',
  rejected: '已驳回',
}

export function relationLabel(r: Pick<Relation, 'from' | 'to' | 'kind'>): string {
  return r.kind === 'earlier'
    ? `${unitLabel(r.from)} 早于 ${unitLabel(r.to)}`
    : `${unitLabel(r.from)} 与 ${unitLabel(r.to)} 同期`
}

/* ---------- 基础工具 ---------- */

const uid = () => crypto.randomUUID()

let toastTimer = 0
export function toast(msg: string) {
  state.toast = msg
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (state.toast = ''), 5000)
}

export function setOperator(name: string) {
  state.operator = name
  localStorage.setItem('hm-operator', name)
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

/** 写入 IndexedDB 前去除 Vue 响应式代理（structuredClone 可处理 Blob，JSON 克隆会破坏它） */
function plain<T>(v: T): T {
  if (v == null) return v
  try {
    return structuredClone(v)
  } catch {
    return JSON.parse(JSON.stringify(v))
  }
}

async function applyForward(m: Mutation) {
  const t = tableOf(m.table)
  if (m.after == null) await t.delete(m.key)
  else await t.put(plain(m.after) as never)
}

async function applyInverse(m: Mutation) {
  const t = tableOf(m.table)
  if (m.before == null) await t.delete(m.key)
  else await t.put(plain(m.before) as never)
}

/** 扫描声明了附件但二进制缺失的证据：缺失需显式提示，不阻塞加载 */
function scanMissingAttachments(evidences: Evidence[], have: Set<string>): Evidence[] {
  return evidences.filter((e) => e.attachment != null && !have.has(e.attachment.id))
}

export async function refresh() {
  const [units, positions, relations, evidences, retractions, reviews, attachments, batches] =
    await Promise.all([
      db.units.toArray(),
      db.positions.toArray(),
      db.relations.toArray(),
      db.evidences.toArray(),
      db.retractions.toArray(),
      db.reviews.orderBy('at').toArray(),
      db.attachments.toArray(),
      db.batches.orderBy('at').toArray(),
    ])
  state.units = units.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  state.positions = Object.fromEntries(positions.map((p) => [p.unitId, p]))
  state.relations = relations.sort((a, b) => a.createdAt - b.createdAt)
  state.evidences = evidences.sort((a, b) => a.createdAt - b.createdAt)
  state.retractions = retractions.sort((a, b) => a.at - b.at)
  state.reviews = reviews
  // Blob 不能被 Vue 响应式代理（会破坏 FileReader / URL.createObjectURL 的内部槽检查）
  state.attachments = Object.fromEntries(attachments.map((a) => [a.id, markRaw(a.blob)]))
  state.batches = batches
  state.missingAttachments = scanMissingAttachments(state.evidences, new Set(Object.keys(state.attachments)))
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

/** 撤销最近一个未撤销的批次：关系、证据、附件随逆向变更一起恢复（审计链永不删除） */
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
  const unit: StratUnit = { id: uid(), label, type, note: note.trim(), createdAt: Date.now() }
  await runBatch(`新增层位 ${label}`, [{ table: 'units', key: unit.id, before: null, after: unit }])
  toast(`已新增层位 ${label}`)
}

export async function deleteUnit(id: string) {
  const unit = state.units.find((u) => u.id === id)
  if (!unit) return
  const mutations: Mutation[] = [{ table: 'units', key: id, before: unit, after: null }]
  const pos = state.positions[id]
  if (pos) mutations.push({ table: 'positions', key: id, before: pos, after: null })
  // 连带删除涉及该层位的关系、其证据/附件及撤销记录（全部记入批次可整体撤销）；
  // 复核审计链不删除，仍可独立查看（关系快照已冗余在 review 中）。
  for (const r of state.relations.filter((r) => r.from === id || r.to === id)) {
    mutations.push({ table: 'relations', key: r.id, before: r, after: null })
    for (const x of state.retractions.filter((x) => x.relationId === r.id)) {
      mutations.push({ table: 'retractions', key: x.id, before: x, after: null })
    }
    for (const e of state.evidences.filter((e) => e.relationId === r.id)) {
      mutations.push({ table: 'evidences', key: e.id, before: e, after: null })
      if (e.attachment) {
        const blob = state.attachments[e.attachment.id]
        if (blob) {
          mutations.push({
            table: 'attachments',
            key: e.attachment.id,
            before: { id: e.attachment.id, blob } satisfies AttachmentBlob,
            after: null,
          })
        }
      }
    }
  }
  await runBatch(`删除层位 ${unit.label}（连带 ${mutations.length - (pos ? 2 : 1)} 项记录）`, mutations)
  if (state.selectedUnitId === id) state.selectedUnitId = null
  toast(`已删除层位 ${unit.label}`)
}

/* ---------- 关系（原始观察） ---------- */

function makeRelation(draft: RelationDraft): Relation {
  return {
    id: uid(),
    from: draft.from,
    to: draft.to,
    kind: draft.kind,
    source: 'observation',
    status: 'active',
    conflict: false,
    note: draft.note.trim(),
    createdAt: Date.now(),
  }
}

/**
 * 新增原始观察关系。关系先以待复核证据的形式存档：在至少一条证据被采纳前，
 * 不影响矩阵与偏序；采纳时若成环，复核决定保留并生成冲突（见 reviewEvidence）。
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
  const relation = makeRelation(draft)
  await runBatch(`新增原始观察：${relationLabel(relation)}`, [
    { table: 'relations', key: relation.id, before: null, after: relation },
  ])
  toast('已登记原始观察（等待证据复核通过后才进入矩阵）')
  return relation.id
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
  await runBatch(`撤回判断：${relationLabel(rel)}`, [
    { table: 'relations', key: id, before: rel, after: { ...rel, status: 'retracted' as const } },
    { table: 'retractions', key: retraction.id, before: null, after: retraction },
  ])
  toast('已撤回，判断与理由已单独存档')
}

/* ---------- 证据与附件 ---------- */

/** 为一条原始观察追加证据（含可选本地附件）；新证据一律为待复核 */
export async function addEvidence(relationId: string, draft: EvidenceDraft) {
  const rel = state.relations.find((r) => r.id === relationId)
  if (!rel) return
  const ev: Evidence = {
    id: uid(),
    relationId,
    type: draft.type,
    text: draft.text.trim(),
    collectedAt: draft.collectedAt,
    attachment: draft.attachment ? { ...draft.attachment.meta } : null,
    createdAt: Date.now(),
  }
  const mutations: Mutation[] = [{ table: 'evidences', key: ev.id, before: null, after: ev }]
  if (draft.attachment) {
    mutations.push({
      table: 'attachments',
      key: draft.attachment.meta.id,
      before: null,
      after: { id: draft.attachment.meta.id, blob: draft.attachment.blob } satisfies AttachmentBlob,
    })
  }
  await runBatch(`登记证据于「${relationLabel(rel)}」`, mutations)
  toast('证据已登记，状态为待复核')
  return ev.id
}

/** 打开本地附件（内容始终留在本机）；附件缺失时显式提示 */
export function openAttachment(ev: Evidence) {
  if (!ev.attachment) return
  const blob = state.attachments[ev.attachment.id]
  if (!blob) {
    toast(`附件「${ev.attachment.name}」在本地缺失（可能被清理或未随导入提供），工程其余数据正常`)
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = ev.attachment.name
  a.click()
  URL.revokeObjectURL(url)
}

/* ---------- 证据复核闭环 ---------- */

/**
 * 采纳 / 驳回一条证据：记录操作者、时间、意见与前后状态。
 * 采纳会造成环时，复核决定照常保留，关系生成冲突（红边）而非静默丢弃，
 * 冲突边不进入有效偏序；驳回是“否决”，只要存在未解决驳回关系即不生效。
 */
export async function reviewEvidence(evidenceId: string, toStatus: 'accepted' | 'rejected', comment: string) {
  const ev = state.evidences.find((x) => x.id === evidenceId)
  if (!ev) return
  const operator = state.operator.trim()
  if (!operator) {
    toast('请先填写操作者名称')
    return
  }
  const rel = state.relations.find((r) => r.id === ev.relationId)
  const fromStatus = evidenceStatus(evidenceId)
  if (fromStatus === toStatus) {
    toast(`该证据当前已是「${reviewStatusNames[toStatus]}」`)
    return
  }
  const review: Review = {
    id: uid(),
    evidenceId,
    evidenceRef: evidenceDisplayName(ev),
    relationId: ev.relationId,
    relationLabel: rel ? relationLabel(rel) : ev.relationId,
    operator,
    comment: comment.trim() || '（未填写意见）',
    at: Date.now(),
    fromStatus,
    toStatus,
    undone: false,
  }
  await db.reviews.put(plain(review))
  await refresh()
  if (toStatus === 'accepted' && isConflict(ev.relationId)) {
    toast(`已采纳，但该关系与既有有效观察构成环：已保留决定并生成冲突，不进入偏序计算`)
  } else {
    toast(`已复核：${reviewStatusNames[fromStatus]} → ${reviewStatusNames[toStatus]}`)
  }
}

/**
 * 撤销最近一次复核：只能撤销该证据最后一条有效决定（审计历史不删除，
 * 仅追加 undone 记录），状态回滚到该决定之前。
 */
export async function undoReview(evidenceId?: string) {
  const target = [...state.reviews]
    .reverse()
    .find((r) => !r.undone && (evidenceId == null || r.evidenceId === evidenceId))
  if (!target) {
    toast('没有可撤销的复核')
    return
  }
  const undoRec: Review = {
    id: uid(),
    evidenceId: target.evidenceId,
    evidenceRef: target.evidenceRef,
    relationId: target.relationId,
    relationLabel: target.relationLabel,
    operator: state.operator.trim() || target.operator,
    comment: `撤销复核：${target.operator}「${target.comment}」`,
    at: Date.now(),
    fromStatus: target.toStatus,
    toStatus: target.fromStatus,
    undone: true,
  }
  await db.reviews.update(target.id, { undone: true })
  await db.reviews.put(plain(undoRec))
  await refresh()
  toast(`已撤销最近一次复核（历史记录保留）：${target.evidenceRef}`)
}

export function evidenceDisplayName(ev: Evidence): string {
  const date = ev.collectedAt ? `${ev.collectedAt} · ` : ''
  const text = ev.text || '（无说明）'
  return `${evidenceTypeNames[ev.type]}｜${date}${text}`
}

/* ---------- 画布位置（与地层身份分离，不进入撤销批次） ---------- */

export async function savePosition(unitId: string, x: number, y: number) {
  const pos: UnitPosition = { unitId, x, y }
  await db.positions.put(pos)
  state.positions = { ...state.positions, [unitId]: pos }
}

/** 按最长路径分层自动排布（忽略成环边） */
export async function autoLayout() {
  const auto = layeredPositions(
    state.units.map((u) => u.id),
    orderEdges.value,
  )
  for (const [id, p] of auto) await db.positions.put({ unitId: id, x: p.x, y: p.y })
  await refresh()
  state.layoutVersion++
  toast('已按有效观察自动分层排布')
}

/* ---------- 示例 / 清空 / 导出 / 导入 ---------- */

export async function loadSample() {
  if (state.units.length > 0 && !window.confirm('载入示例将先清空当前工程（不可撤销），继续？')) return
  await clearAll(false)
  const now = Date.now()
  const sample = buildSample(now)
  const positions = layeredPositions(
    sample.units.map((u) => u.id),
    sampleEffectiveEdges(sample.evidences, sample.reviews, sample.relations),
  )
  const mutations: Mutation[] = []
  for (const u of sample.units) mutations.push({ table: 'units', key: u.id, before: null, after: u })
  for (const e of sample.evidences) mutations.push({ table: 'evidences', key: e.id, before: null, after: e })
  // 示例故意有一个声明了附件但二进制缺失的证据，演示“缺失附件显式提示、不阻塞加载”
  for (const a of sample.attachments) {
    mutations.push({ table: 'attachments', key: a.id, before: null, after: a })
  }
  for (const r of sample.relations) mutations.push({ table: 'relations', key: r.id, before: null, after: r })
  for (const x of sample.retractions) mutations.push({ table: 'retractions', key: x.id, before: null, after: x })
  for (const v of sample.reviews) mutations.push({ table: 'reviews', key: v.id, before: null, after: v })
  for (const u of sample.units) {
    const p = positions.get(u.id)
    if (p) mutations.push({ table: 'positions', key: u.id, before: null, after: { unitId: u.id, ...p } })
  }
  await runBatch('载入示例工程', mutations)
  state.layoutVersion++
  toast('示例工程已载入（含待复核/驳回证据、成环冲突、混合证据与缺失附件提示）')
}

export async function clearAll(confirm = true) {
  if (confirm && !window.confirm('清空全部工程数据？此操作不可撤销。')) return
  await db.transaction(
    'rw',
    [db.units, db.positions, db.relations, db.evidences, db.retractions, db.reviews, db.attachments, db.batches],
    async () => {
      await Promise.all([
        db.units.clear(),
        db.positions.clear(),
        db.relations.clear(),
        db.evidences.clear(),
        db.retractions.clear(),
        db.reviews.clear(),
        db.attachments.clear(),
        db.batches.clear(),
      ])
    },
  )
  state.selectedUnitId = null
  await refresh()
  if (confirm) toast('工程已清空')
}

/* ---------- 导出（附件 base64 内联，纯本地文件） ---------- */

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '')
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(blob)
  })
}

function base64ToBlob(base64: string, mime: string): Blob {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

export async function exportProject() {
  const attachments: ProjectExport['attachments'] = []
  for (const ev of state.evidences) {
    if (!ev.attachment) continue
    const blob = state.attachments[ev.attachment.id]
    if (!blob) continue // 缺失附件不阻断导出，元数据保留
    attachments.push({ ...ev.attachment, base64: await blobToBase64(blob) })
  }
  const data: ProjectExport = {
    app: 'harris-matrix-workbench',
    version: 2,
    exportedAt: new Date().toISOString(),
    units: state.units,
    positions: Object.values(state.positions),
    relations: state.relations,
    evidences: state.evidences,
    retractions: state.retractions,
    reviews: state.reviews,
    attachments,
    partialOrder: reachablePairs(orderEdges.value),
  }
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `harris-matrix-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
  const missing = state.missingAttachments.length
  toast(
    `已导出（偏序闭包 ${data.partialOrder.length} 个可达对、复核记录 ${state.reviews.length} 条` +
      (missing ? `；${missing} 个缺失附件未包含` : '') +
      '）',
  )
}

/* ---------- 导入（v2 全量恢复 / v1 迁移） ---------- */

/** 规整外部数据：补齐 v2 字段；v1 的“关系引用全局证据”迁移为“证据归属关系” */
function normalizeImport(data: any): {
  units: StratUnit[]
  positions: UnitPosition[]
  relations: Relation[]
  evidences: Evidence[]
  retractions: Retraction[]
  reviews: Review[]
  attachments: AttachmentBlob[]
  partialOrder: string[]
} | null {
  if (data?.app !== 'harris-matrix-workbench' || !Array.isArray(data.units) || !Array.isArray(data.relations)) {
    return null
  }
  const relations: Relation[] = data.relations.map((r: any) => ({
    id: String(r.id),
    from: String(r.from),
    to: String(r.to),
    kind: r.kind === 'contemporary' ? 'contemporary' : 'earlier',
    source: r.source === 'inference' ? 'inference' : 'observation',
    status: r.status === 'retracted' ? 'retracted' : 'active',
    conflict: Boolean(r.conflict),
    evidenceIds: Array.isArray(r.evidenceIds) ? r.evidenceIds.map(String) : undefined,
    note: String(r.note ?? ''),
    createdAt: Number(r.createdAt) || Date.now(),
  }))

  let evidences: Evidence[] = []
  if (data.version === 2 && Array.isArray(data.evidences)) {
    evidences = data.evidences.map((e: any) => ({
      id: String(e.id),
      relationId: String(e.relationId),
      type: (['diary', 'photo', 'section', 'card', 'other'].includes(e.type) ? e.type : 'other') as Evidence['type'],
      text: String(e.text ?? ''),
      collectedAt: String(e.collectedAt ?? ''),
      attachment: e.attachment
        ? {
            id: String(e.attachment.id),
            name: String(e.attachment.name ?? '附件'),
            mime: String(e.attachment.mime ?? ''),
            size: Number(e.attachment.size ?? 0),
          }
        : null,
      createdAt: Number(e.createdAt) || Date.now(),
    }))
  } else {
    // v1：全局证据 + relation.evidenceIds → 按引用复制归属到各关系
    const oldList: any[] = Array.isArray(data.evidences) ? data.evidences : []
    const oldById = new Map(oldList.map((e) => [String(e.id), e]))
    for (const r of relations) {
      for (const refId of r.evidenceIds ?? []) {
        const old = oldById.get(refId)
        if (!old) continue
        evidences.push({
          id: `${r.id}__${refId}`,
          relationId: r.id,
          type: 'other',
          text: String(old.text ?? ''),
          collectedAt: '',
          attachment: null,
          createdAt: Number(old.createdAt) || r.createdAt,
        })
      }
    }
    for (const r of relations) delete r.evidenceIds
  }

  const reviews: Review[] = Array.isArray(data.reviews)
    ? data.reviews.map((v: any) => ({
        id: String(v.id),
        evidenceId: String(v.evidenceId),
        evidenceRef: String(v.evidenceRef ?? ''),
        relationId: String(v.relationId ?? ''),
        relationLabel: String(v.relationLabel ?? ''),
        operator: String(v.operator ?? ''),
        comment: String(v.comment ?? ''),
        at: Number(v.at) || Date.now(),
        fromStatus: (['pending', 'accepted', 'rejected'].includes(v.fromStatus) ? v.fromStatus : 'pending') as ReviewStatus,
        toStatus: (['accepted', 'rejected'].includes(v.toStatus) ? v.toStatus : 'pending') as ReviewStatus,
        undone: Boolean(v.undone),
      }))
    : []

  const attachments: AttachmentBlob[] = []
  for (const a of Array.isArray(data.attachments) ? data.attachments : []) {
    try {
      attachments.push({ id: String(a.id), blob: base64ToBlob(String(a.base64 ?? ''), String(a.mime ?? '')) })
    } catch {
      // 单个附件损坏不阻塞整个工程导入
    }
  }

  return {
    units: data.units,
    positions: Array.isArray(data.positions) ? data.positions : [],
    relations,
    evidences,
    retractions: Array.isArray(data.retractions) ? data.retractions : [],
    reviews,
    attachments,
    partialOrder: Array.isArray(data.partialOrder) ? data.partialOrder.map(String) : [],
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
  const data = normalizeImport(raw)
  if (!data) {
    toast('导入失败：文件格式不符')
    return
  }
  if (!window.confirm('导入将替换当前工程（不可撤销），继续？')) return
  await db.transaction(
    'rw',
    [db.units, db.positions, db.relations, db.evidences, db.retractions, db.reviews, db.attachments, db.batches],
    async () => {
      await Promise.all([
        db.units.clear(),
        db.positions.clear(),
        db.relations.clear(),
        db.evidences.clear(),
        db.retractions.clear(),
        db.reviews.clear(),
        db.attachments.clear(),
        db.batches.clear(),
      ])
      await db.units.bulkPut(plain(data.units))
      await db.positions.bulkPut(plain(data.positions))
      await db.relations.bulkPut(plain(data.relations))
      await db.evidences.bulkPut(plain(data.evidences))
      await db.retractions.bulkPut(plain(data.retractions))
      await db.reviews.bulkPut(plain(data.reviews))
      await db.attachments.bulkPut(plain(data.attachments))
    },
  )
  await refresh()
  state.layoutVersion++
  // 偏序一致性校验：用当前证据闸门+冲突分析重算可达对，与导出快照比对
  const expected = [...data.partialOrder].sort()
  const actual = reachablePairs(orderEdges.value)
  const same = JSON.stringify(expected) === JSON.stringify(actual)
  const missing = state.missingAttachments.length
  toast(
    (same
      ? `导入完成，偏序校验一致（${actual.length} 个可达对）`
      : '导入完成，但偏序与导出时不一致，请检查证据复核状态与冲突') +
      (missing ? `；${missing} 个附件在本地缺失，已显式标注（工程数据完整可查）` : ''),
  )
}
