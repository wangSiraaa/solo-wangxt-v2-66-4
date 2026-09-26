import Dexie, { type Table } from 'dexie'
import type {
  AttachmentBlob,
  Batch,
  Evidence,
  Relation,
  Retraction,
  Review,
  StratUnit,
  UnitPosition,
} from './types'

/**
 * 纯本地存储：所有现场资料只写入浏览器 IndexedDB，不发生任何网络上传。
 * 原始观察 / 推断关系（relations 表，以 source 区分）、被撤销判断（retractions 表）分开保存。
 * v2：证据归属于具体关系并带附件元数据；reviews 表为不可删除的复核审计链；
 *     attachments 表单独存放附件二进制（缺失附件不阻塞工程加载）。
 */
class MatrixDB extends Dexie {
  units!: Table<StratUnit, string>
  positions!: Table<UnitPosition, string>
  relations!: Table<Relation, string>
  evidences!: Table<Evidence, string>
  retractions!: Table<Retraction, string>
  reviews!: Table<Review, string>
  attachments!: Table<AttachmentBlob, string>
  batches!: Table<Batch, string>

  constructor() {
    super('harris-matrix')
    this.version(1).stores({
      units: 'id',
      positions: 'unitId',
      relations: 'id, from, to, status',
      evidences: 'id',
      retractions: 'id, relationId',
      batches: 'id, at',
    })
    this.version(2)
      .stores({
        units: 'id',
        positions: 'unitId',
        relations: 'id, from, to, status',
        evidences: 'id, relationId',
        retractions: 'id, relationId',
        reviews: 'id, evidenceId, at',
        attachments: 'id',
        batches: 'id, at',
      })
      .upgrade(async (tx) => {
        // v1 → v2：证据从“全局共享、被关系引用”迁移为“归属于具体关系”。
        // 被关系引用的旧证据按引用复制到对应关系；未被引用的旧证据不进入复核闭环。
        const oldRelations = await tx.table('relations').toCollection().toArray()
        const oldEvidences = await tx.table('evidences').toCollection().toArray()
        const evById = new Map<string, any>(oldEvidences.map((e: any) => [e.id, e]))
        const next = new Map<string, any>()
        for (const r of oldRelations as any[]) {
          for (const evId of r.evidenceIds ?? []) {
            const old = evById.get(evId)
            if (!old) continue
            next.set(old.id, {
              id: old.id,
              relationId: r.id,
              type: 'other',
              text: old.text ?? '',
              collectedAt: '',
              attachment: null,
              createdAt: old.createdAt ?? Date.now(),
            })
          }
        }
        await tx.table('evidences').clear()
        if (next.size > 0) await tx.table('evidences').bulkPut([...next.values()])
      })
  }
}

export const db = new MatrixDB()
