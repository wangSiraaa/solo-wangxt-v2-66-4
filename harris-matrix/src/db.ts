import Dexie, { type Table } from 'dexie'
import type { AttachmentBlob, Batch, Evidence, Relation, Retraction, ReviewRecord, StratUnit, UnitPosition } from './types'

/**
 * 纯本地存储：所有现场资料只写入浏览器 IndexedDB，不发生任何网络上传。
 * 原始观察 / 推断关系（relations 表，以 source 区分）、被撤销判断（retractions 表）、
 * 复核审计链（reviews 表，只追加）、附件二进制（attachments 表）分开保存。
 */
class MatrixDB extends Dexie {
  units!: Table<StratUnit, string>
  positions!: Table<UnitPosition, string>
  relations!: Table<Relation, string>
  evidences!: Table<Evidence, string>
  reviews!: Table<ReviewRecord, string>
  attachments!: Table<AttachmentBlob, string>
  retractions!: Table<Retraction, string>
  batches!: Table<Batch, string>

  constructor() {
    super('harris-matrix')
    // v1：层位 / 位置 / 关系 / 证据 / 撤销 / 批次
    this.version(1).stores({
      units: 'id',
      positions: 'unitId',
      relations: 'id, from, to, status',
      evidences: 'id',
      retractions: 'id, relationId',
      batches: 'id, at',
    })
    // v2：证据复核闭环——证据按关系归属；新增 reviews 审计链与 attachments 二进制表
    this.version(2).stores({
      units: 'id',
      positions: 'unitId',
      relations: 'id, from, to, status',
      evidences: 'id, relationId',
      reviews: 'id, evidenceId, at',
      attachments: 'id',
      retractions: 'id, relationId',
      batches: 'id, at',
    })
  }
}

export const db = new MatrixDB()
