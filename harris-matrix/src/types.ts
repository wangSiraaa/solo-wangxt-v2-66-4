/** 层位类型：堆积 / 切割 / 填充 / 界面 */
export type UnitType = 'deposit' | 'cut' | 'fill' | 'interface' | 'other'

/** 关系种类：earlier = 有向先后（from 早于 to）；contemporary = 同期关联（不进入有向图） */
export type RelationKind = 'earlier' | 'contemporary'

/** 关系来源：原始观察 / 推断（推断关系由有效观察集实时导出，旧版手填推断仅存档） */
export type RelationSource = 'observation' | 'inference'

export type RelationStatus = 'active' | 'retracted'

/** 证据复核状态：待复核 / 已采纳 / 已驳回 */
export type EvidenceReviewStatus = 'pending' | 'accepted' | 'rejected'

/** 证据类型：照片 / 剖面图 / 田野日记 / 测绘记录 / 其他 */
export type EvidenceType = 'photo' | 'section' | 'diary' | 'survey' | 'other'

/** 复核动作：采纳 / 驳回（撤销通过将审计记录标记 undone 实现，不产生删除） */
export type ReviewAction = 'adopt' | 'reject'

/** 地层身份：与画布位置完全分离 */
export interface StratUnit {
  id: string
  label: string
  type: UnitType
  note: string
  createdAt: number
}

/** 画布位置：独立成表，删除/修改不影响地层身份 */
export interface UnitPosition {
  unitId: string
  x: number
  y: number
}

export interface Relation {
  id: string
  from: string
  to: string
  kind: RelationKind
  source: RelationSource
  status: RelationStatus
  /** 与既有记录构成环时被标记为矛盾记录（仍保留为证据） */
  conflict: boolean
  evidenceIds: string[]
  note: string
  createdAt: number
}

/** 附件本地元数据：内容本身存于 attachments 表（Blob），JSON 中只携带元数据 */
export interface AttachmentMeta {
  id: string
  name: string
  mime: string
  size: number
}

/**
 * 原始证据：附属于某一条原始观察关系（一条观察可附多条证据）。
 * 含类型、说明、采集日期与本地附件元数据；附件 Blob 仅保存在本机 IndexedDB。
 */
export interface Evidence {
  id: string
  /** 所属原始观察关系 */
  relationId: string
  type: EvidenceType
  /** 说明 */
  note: string
  /** 采集日期（YYYY-MM-DD） */
  collectedAt: string
  attachment: AttachmentMeta | null
  createdAt: number
}

/**
 * 复核审计记录：只追加、不删除。
 * 撤销最近一次复核 = 将最近一条记录标记 undone，历史仍然保留可查。
 */
export interface ReviewRecord {
  id: string
  /** 单调序号：同一毫秒内多条复核也有确定的先后（用于“最近一次复核”） */
  seq: number
  evidenceId: string
  action: ReviewAction
  operator: string
  comment: string
  at: number
  fromStatus: EvidenceReviewStatus
  toStatus: EvidenceReviewStatus
  /** 撤销后置 true：决定被回滚，但审计链不删除 */
  undone: boolean
}

/**
 * 附件二进制内容：独立成表，绝不进入 JSON 结构克隆路径。
 * bytes 为结构化克隆友好的 Uint8Array（浏览器中由 Blob.arrayBuffer 得到）。
 */
export interface AttachmentBlob {
  id: string
  bytes: Uint8Array
  mime: string
  name: string
}

/** 被撤销的判断：单独成表保存快照与理由，不混入活跃关系 */
export interface Retraction {
  id: string
  relationId: string
  snapshot: Relation
  reason: string
  at: number
}

export type TableName =
  | 'units'
  | 'positions'
  | 'relations'
  | 'evidences'
  | 'retractions'
  | 'reviews'
  | 'attachments'

/** 通用变更记录：before/after 支持正向应用与逆向撤销 */
export interface Mutation {
  table: TableName
  key: string
  before: unknown | null
  after: unknown | null
}

/** 一批操作（可整体撤销） */
export interface Batch {
  id: string
  label: string
  at: number
  undone: boolean
  mutations: Mutation[]
}

export interface RelationDraft {
  from: string
  to: string
  kind: RelationKind
  source: RelationSource
  evidenceIds: string[]
  note: string
}

/** 导出文件中携带的附件：元数据 + data URL 内容，保证导出再导入后附件仍可用 */
export interface AttachmentPayload extends AttachmentMeta {
  dataUrl: string
}

/** 导出文件格式：携带偏序闭包与复核审计链用于导入校验 */
export interface ProjectExport {
  app: 'harris-matrix-workbench'
  version: 2
  exportedAt: string
  units: StratUnit[]
  positions: UnitPosition[]
  relations: Relation[]
  evidences: Evidence[]
  reviews: ReviewRecord[]
  attachments: AttachmentPayload[]
  retractions: Retraction[]
  /** 有效偏序的全部可达对（排序后），导入时重算比对 */
  partialOrder: string[]
}
