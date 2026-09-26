/** 层位类型：堆积 / 切割 / 填充 / 界面 */
export type UnitType = 'deposit' | 'cut' | 'fill' | 'interface' | 'other'

/** 关系种类：earlier = 有向先后（from 早于 to）；contemporary = 同期关联（不进入有向图） */
export type RelationKind = 'earlier' | 'contemporary'

/** 关系来源：原始观察 / 推断（推断边由有效观察实时派生，历史推断记录仅存档） */
export type RelationSource = 'observation' | 'inference'

export type RelationStatus = 'active' | 'retracted'

/** 证据类型：日记 / 照片 / 剖面图 / 地层卡 / 其他 */
export type EvidenceType = 'diary' | 'photo' | 'section' | 'card' | 'other'

/** 复核状态：待复核 / 已采纳 / 已驳回（驳回即“否决”，撤销复核后回到待复核） */
export type ReviewStatus = 'pending' | 'accepted' | 'rejected'

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
  /** 与有效观察构成环时标记为矛盾记录（由当前证据复核状态实时派生，历史字段仅为旧版兼容保留） */
  conflict: boolean
  /** 旧版（v1）共享证据引用；v2 起证据归属于具体关系（Evidence.relationId） */
  evidenceIds?: string[]
  note: string
  createdAt: number
}

/**
 * 原始证据：归属于一条原始观察关系。
 * 含类型、说明、采集日期与本地附件元数据；复核状态由 reviews 审计链的最新有效决定。
 * 所有内容仅保存在本地 IndexedDB，不发生任何网络上传。
 */
export interface Evidence {
  id: string
  relationId: string
  type: EvidenceType
  text: string
  /** 采集日期（YYYY-MM-DD） */
  collectedAt: string
  /** 本地附件元数据；附件二进制单独存于 attachments 表，缺失时给出显式提示 */
  attachment: AttachmentMeta | null
  createdAt: number
}

/** 附件元数据：随证据/导出携带；blob 在 IndexedDB 或导出 JSON 的 attachments 段中 */
export interface AttachmentMeta {
  id: string
  name: string
  mime: string
  size: number
}

/** 附件二进制：内容仍保存在浏览器本地（IndexedDB），不进入关系表 */
export interface AttachmentBlob {
  id: string
  blob: Blob
}

/**
 * 复核记录（审计链）：每次采纳/驳回都追加一条，不可删除。
 * 撤销复核只是再追加一条 undone 记录，证据状态回滚到 fromStatus。
 */
export interface Review {
  id: string
  evidenceId: string
  /** 冗余快照：即使证据/关系被删除，审计链仍可读 */
  evidenceRef: string
  relationId: string
  relationLabel: string
  operator: string
  comment: string
  at: number
  fromStatus: ReviewStatus
  toStatus: ReviewStatus
  /** true = 撤销最近一次复核的操作记录（历史保留） */
  undone: boolean
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
  note: string
}

/** 新增证据表单 */
export interface EvidenceDraft {
  type: EvidenceType
  text: string
  collectedAt: string
  attachment: { meta: AttachmentMeta; blob: Blob } | null
}

/** 导出文件格式：携带偏序闭包、复核审计链与附件（base64），用于导入校验与归档 */
export interface ProjectExport {
  app: 'harris-matrix-workbench'
  version: 2
  exportedAt: string
  units: StratUnit[]
  positions: UnitPosition[]
  relations: Relation[]
  evidences: Evidence[]
  retractions: Retraction[]
  reviews: Review[]
  /** 附件内容 base64（纯本地导出，不上传） */
  attachments: Array<AttachmentMeta & { base64: string }>
  /** 有效（采纳且无未解决否决、且不成环）“早于”关系的可达对闭包（排序后），导入时重算比对 */
  partialOrder: string[]
}
