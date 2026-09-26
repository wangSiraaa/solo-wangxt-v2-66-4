import type { Evidence, EvidenceType, Relation, ReviewRecord } from './types'

/** 旧版证据没有归属关系 / 类型 / 采集日期（仅有 ref、text），需迁移到复核模型 */
export function isLegacyEvidence(e: unknown): boolean {
  const r = e as Record<string, unknown> | null | undefined
  return !!r && (r.relationId === undefined || r.relationId === null)
}

function toDateInput(ms: number): string {
  const d = new Date(isFinite(ms) ? ms : Date.now())
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 旧版证据迁移：补全归属关系、类型、采集日期；并生成一条显式的「系统迁移·采纳」
 * 审计记录（确定性 id，幂等），保证既有工程的观察在新规则下仍然有效，且审计链完整。
 */
export function migrateEvidence(raw0: unknown, relationId: string): { evidence: Evidence; review: ReviewRecord } {
  const raw = raw0 as { id: string; ref?: string; text?: string; createdAt?: number }
  const createdAt = raw.createdAt ?? Date.now()
  const note = [raw.ref, raw.text].filter((s) => s && s.trim()).join('｜')
  const evidence: Evidence = {
    id: raw.id,
    relationId,
    type: 'other' as EvidenceType,
    note,
    collectedAt: toDateInput(createdAt),
    attachment: null,
    createdAt,
  }
  const review: ReviewRecord = {
    id: `RV:mig:${raw.id}`,
    seq: 0,
    evidenceId: raw.id,
    action: 'adopt',
    operator: '系统迁移',
    comment: '旧版工程中的既有证据，迁移时默认采纳',
    at: createdAt + 1,
    fromStatus: 'pending',
    toStatus: 'accepted',
    undone: false,
  }
  return { evidence, review }
}

/** 批量迁移旧版证据：按关系上的 evidenceIds 归属，无引用者归入孤儿桶 */
export function migrateLegacy(
  rawEvidences: unknown[],
  relations: Relation[],
): { evidences: Evidence[]; reviews: ReviewRecord[] } {
  const evidences: Evidence[] = []
  const reviews: ReviewRecord[] = []
  rawEvidences.forEach((raw0) => {
    const raw = raw0 as { id: string }
    const owner = relations.find((r) => r.evidenceIds.includes(raw.id))
    const { evidence, review } = migrateEvidence(raw0, owner ? owner.id : '__orphan__')
    evidences.push(evidence)
    reviews.push(review)
  })
  return { evidences, reviews }
}
