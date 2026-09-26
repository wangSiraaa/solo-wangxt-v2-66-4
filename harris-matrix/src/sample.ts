import { conflictSplit } from './graph'
import type { AttachmentBlob, Evidence, Relation, Retraction, Review, StratUnit } from './types'

/**
 * 示例工程：一处含基槽切割、灰坑切割的堆积序列。
 * 覆盖证据复核闭环的全部状态：
 *  - R1~R7：证据已采纳的有效观察（含同期关联）；
 *  - R8：同一关系多证据混合（已采纳 + 已驳回否决 + 待复核）→ 不生效；
 *  - R9：仅有待复核证据 → 不影响矩阵；
 *  - R10：采纳造成环 → 保留复核决定并生成冲突，不进入偏序；
 *  - R11：已撤回的原始观察；
 *  - E1 声明了附件但本地二进制缺失（显式提示、不阻塞加载），E4 附件可正常打开。
 */
export function buildSample(now: number): {
  units: StratUnit[]
  evidences: Evidence[]
  relations: Relation[]
  retractions: Retraction[]
  reviews: Review[]
  attachments: AttachmentBlob[]
} {
  const units: StratUnit[] = [
    { id: '1001', label: '1001', type: 'deposit', note: '现代表土层', createdAt: now },
    { id: '1003', label: '1003', type: 'deposit', note: '冲积淤积层', createdAt: now },
    { id: '1005', label: '1005', type: 'fill', note: '基槽填土', createdAt: now },
    { id: '1006', label: '1006', type: 'cut', note: '基槽切割（切割事件）', createdAt: now },
    { id: '1007', label: '1007', type: 'interface', note: '被切割的居住面', createdAt: now },
    { id: '1009', label: '1009', type: 'fill', note: '灰坑填土', createdAt: now },
    { id: '1010', label: '1010', type: 'cut', note: '灰坑切割（切割事件）', createdAt: now },
    { id: '1012', label: '1012', type: 'deposit', note: '陶片富集层', createdAt: now },
    { id: '1015', label: '1015', type: 'interface', note: '踩踏面', createdAt: now },
    { id: '1018', label: '1018', type: 'deposit', note: '孤立层位：探方东南角，关系未明', createdAt: now },
  ]

  // [id, from, to, kind, note]
  const raw: Array<[string, string, string, Relation['kind'], string]> = [
    ['R1', '1003', '1001', 'earlier', '淤积层被表土覆盖'],
    ['R2', '1007', '1003', 'earlier', '居住面被淤积层覆盖'],
    ['R3', '1007', '1006', 'earlier', '基槽切割居住面，切割更晚'],
    ['R4', '1006', '1005', 'earlier', '填土晚于切割本身'],
    ['R5', '1012', '1010', 'earlier', '灰坑切割陶片层'],
    ['R6', '1010', '1009', 'earlier', '坑内填土晚于坑的切割'],
    ['R7', '1012', '1015', 'contemporary', '陶片层与踩踏面为同期活动面（无向关联）'],
    ['R8', '1009', '1003', 'earlier', '灰坑填土与淤积层的关系：证据互相矛盾'],
    ['R9', '1005', '1001', 'earlier', '基槽填土直接被表土覆盖？证据待复核'],
    ['R10', '1009', '1012', 'earlier', '记录员乙：灰坑填土早于陶片层（与剖面观察成环）'],
    ['R11', '1015', '1003', 'earlier', '踩踏面被淤积层覆盖（已撤回）'],
  ]
  const relations: Relation[] = raw.map(([id, from, to, kind, note], i) => ({
    id,
    from,
    to,
    kind,
    source: 'observation',
    status: id === 'R11' ? 'retracted' : 'active',
    conflict: false,
    note,
    createdAt: now + i,
  }))

  // [id, relation, type, text, collectedAt, attachmentId]
  const evRows: Array<[string, string, Evidence['type'], string, string, string | null]> = [
    ['E1', 'R1', 'diary', '田野日记第12页：1003 淤积层被 1001 表土直接覆盖，界面清晰。', '2026-09-02', 'A1'],
    ['E12', 'R1', 'photo', '表土界面照片待冲印核对（待复核，不影响已采纳结论）。', '2026-09-02', null],
    ['E2', 'R2', 'section', '剖面图 S-04：居住面 1007 之上叠压淤积层 1003。', '2026-09-03', null],
    ['E3', 'R3', 'section', '剖面图 S-04：基槽 1006 切穿居住面 1007。', '2026-09-03', null],
    ['E4', 'R4', 'photo', '照片 IMG_2031：槽内填土 1005 晚于基槽切割 1006。', '2026-09-04', 'A2'],
    ['E5', 'R5', 'photo', '灰坑 1010 剖面：坑口切过陶片层 1012。', '2026-09-05', null],
    ['E6', 'R6', 'photo', '坑内填土 1009 晚于坑的切割 1010。', '2026-09-05', null],
    ['E7', 'R7', 'card', '地层卡#9：陶片层与踩踏面为同一期活动面。', '2026-09-06', null],
    ['E8', 'R8', 'section', '剖面复核：灰坑填土 1009 被淤积层 1003 覆盖（曾误驳回，复核后采纳）。', '2026-09-08', null],
    ['E9', 'R8', 'card', '记录员乙地层卡#7：反对，认为叠压关系证据不足（未解决否决）。', '2026-09-08', null],
    ['E11', 'R9', 'photo', '仅一张模糊照片，尚待复核。', '2026-09-09', null],
    ['E10', 'R10', 'card', '记录员乙坚持：灰坑填土 1009 早于陶片层 1012。', '2026-09-10', null],
  ]
  const attMeta: Record<string, NonNullable<Evidence['attachment']>> = {
    // A1 故意只有元数据、没有二进制 → 刷新后提示“附件缺失”
    A1: { id: 'A1', name: 'IMG_2025_表土界面.jpg', mime: 'image/jpeg', size: 842100 },
    A2: { id: 'A2', name: 'S-04-基槽剖面记录.txt', mime: 'text/plain', size: 0 },
  }
  const evidences: Evidence[] = evRows.map(([id, relationId, type, text, collectedAt, attId], i) => ({
    id,
    relationId,
    type,
    text,
    collectedAt,
    attachment: attId ? { ...attMeta[attId] } : null,
    createdAt: now + 100 + i,
  }))

  const reviews: Review[] = [
    // E1~E7 直接采纳
    ...(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'] as const).map((eid, i): Review => {
      const ev = evidences.find((e) => e.id === eid)!
      return {
        id: `V-${eid}`,
        evidenceId: eid,
        evidenceRef: ev.text,
        relationId: ev.relationId,
        relationLabel: '',
        operator: '记录员甲',
        comment: '剖面与日记互证，采纳。',
        at: now + 200 + i,
        fromStatus: 'pending',
        toStatus: 'accepted',
        undone: false,
      }
    }),
    // E8：先误驳回 → 撤销该复核（审计保留）→ 重新采纳
    {
      id: 'V-E8-1',
      evidenceId: 'E8',
      evidenceRef: evidences.find((e) => e.id === 'E8')!.text,
      relationId: 'R8',
      relationLabel: '',
      operator: '记录员甲',
      comment: '初判与乙的记录冲突，暂驳回。',
      at: now + 300,
      fromStatus: 'pending',
      toStatus: 'rejected',
      undone: true,
    },
    {
      id: 'V-E8-1u',
      evidenceId: 'E8',
      evidenceRef: evidences.find((e) => e.id === 'E8')!.text,
      relationId: 'R8',
      relationLabel: '',
      operator: '记录员甲',
      comment: '撤销复核：记录员甲「初判与乙的记录冲突，暂驳回。」',
      at: now + 301,
      fromStatus: 'rejected',
      toStatus: 'pending',
      undone: true,
    },
    {
      id: 'V-E8-2',
      evidenceId: 'E8',
      evidenceRef: evidences.find((e) => e.id === 'E8')!.text,
      relationId: 'R8',
      relationLabel: '',
      operator: '记录员甲',
      comment: '剖面复核确认叠压，采纳；乙的反对证据 E9 仍未解决，关系暂不生效。',
      at: now + 302,
      fromStatus: 'pending',
      toStatus: 'accepted',
      undone: false,
    },
    // E9：驳回（未解决否决）
    {
      id: 'V-E9-1',
      evidenceId: 'E9',
      evidenceRef: evidences.find((e) => e.id === 'E9')!.text,
      relationId: 'R8',
      relationLabel: '',
      operator: '记录员丙',
      comment: '复核会上乙的反对成立，该证据驳回，形成未解决否决。',
      at: now + 310,
      fromStatus: 'pending',
      toStatus: 'rejected',
      undone: false,
    },
    // E10：采纳 → 与 1012→1010→1009 成环，保留决定并生成冲突
    {
      id: 'V-E10-1',
      evidenceId: 'E10',
      evidenceRef: evidences.find((e) => e.id === 'E10')!.text,
      relationId: 'R10',
      relationLabel: '',
      operator: '记录员乙',
      comment: '乙坚持己见并签字采纳；系统保留该决定并标记成环冲突。',
      at: now + 320,
      fromStatus: 'pending',
      toStatus: 'accepted',
      undone: false,
    },
  ]

  const retractions: Retraction[] = [
    {
      id: 'X1',
      relationId: 'R11',
      snapshot: { ...relations.find((r) => r.id === 'R11')! },
      reason: '剖面复核后 1015 与 1003 的叠压关系不明，撤回该观察。',
      at: now + 400,
    },
  ]

  // A2：附件二进制真实存在（纯文本，演示本地附件可用）
  const attachments: AttachmentBlob[] = [
    { id: 'A2', blob: new Blob(['S-04 基槽剖面记录（示例附件）：1006 切穿 1007，槽内填土 1005。'], { type: 'text/plain' }) },
  ]

  // 关系标签冗余进每条审计记录：关系日后被删除时审计链仍可读
  const labelOf = (rid: string) => {
    const r = relations.find((x) => x.id === rid)
    if (!r) return rid
    return r.kind === 'earlier' ? `${r.from} 早于 ${r.to}` : `${r.from} 与 ${r.to} 同期`
  }
  for (const v of reviews) v.relationLabel = labelOf(v.relationId)

  return { units, evidences, relations, retractions, reviews, attachments }
}

/** 供示例装载时复用：按当前复核状态求有效、无环的边（与 store 的实时规则一致） */
export function sampleEffectiveEdges(
  evidences: Evidence[],
  reviews: Review[],
  relations: Relation[],
): { id: string; from: string; to: string }[] {
  const statusOf = new Map<string, string>()
  for (const v of reviews) if (!v.undone) statusOf.set(v.evidenceId, v.toStatus)
  const gated = relations
    .filter((r) => r.status === 'active' && r.kind === 'earlier' && r.source === 'observation')
    .filter((r) => {
      const evs = evidences.filter((e) => e.relationId === r.id)
      const acc = evs.some((e) => statusOf.get(e.id) === 'accepted')
      const rej = evs.some((e) => statusOf.get(e.id) === 'rejected')
      return acc && !rej
    })
    .map((r) => ({ id: r.id, from: r.from, to: r.to }))
  return conflictSplit(gated).skeleton
}
