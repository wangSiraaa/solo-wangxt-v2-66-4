import type { AttachmentBlob, Evidence, Relation, Retraction, ReviewRecord, StratUnit } from './types'

/**
 * 示例工程：一处含基槽切割、灰坑切割的堆积序列。
 * 复核闭环相关素材：
 *  - R1/R2/R3 证据均已采纳（有效观察，参与偏序）；
 *  - R4 混合状态：一条采纳 + 一条驳回（未解决否决 → 不生效）；
 *  - R7 的「记录员乙」证据待复核时矩阵无环；采纳后与剖面观察成环（冲突保留）；
 *  - R10 是一条被撤销复核的演示（审计记录仍保留）；
 *  - R11 仅有待复核证据（不影响矩阵），其附件 Blob 本机缺失（显式提示但不阻断加载）；
 *  - R5/R8 是旧版手填「推断」存档（不参与计算，界面灰显）；
 *  - R6 有一条真实附件（可下载）。
 */
export function buildSample(now: number): {
  units: StratUnit[]
  evidences: Evidence[]
  reviews: ReviewRecord[]
  attachments: AttachmentBlob[]
  relations: Relation[]
  retractions: Retraction[]
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

  // [id, from, to, kind, source, note]
  const raw: Array<[string, string, string, Relation['kind'], Relation['source'], string]> = [
    ['R1', '1003', '1001', 'earlier', 'observation', '淤积层被表土覆盖'],
    ['R2', '1007', '1003', 'earlier', 'observation', '居住面被淤积层覆盖'],
    ['R3', '1007', '1006', 'earlier', 'observation', '基槽切割居住面，切割更晚'],
    ['R4', '1006', '1005', 'earlier', 'observation', '填土晚于切割本身（证据有争议）'],
    ['R5', '1005', '1003', 'earlier', 'inference', '旧版手填推断存档：基槽填土被淤积层覆盖'],
    ['R6', '1012', '1010', 'earlier', 'observation', '灰坑切割陶片层'],
    ['R7', '1010', '1009', 'earlier', 'observation', '坑内填土晚于坑的切割'],
    ['R8', '1009', '1003', 'earlier', 'inference', '旧版手填推断存档：灰坑填土被淤积层覆盖'],
    ['R9', '1012', '1015', 'contemporary', 'observation', '陶片层与踩踏面为同期活动面（无向关联）'],
    // 矛盾记录：剖面观察采纳后，与 R6→R7 构成环
    ['R10', '1009', '1012', 'earlier', 'observation', '记录员乙：灰坑填土早于陶片层'],
    // 待复核：不影响矩阵；附件缺失演示
    ['R11', '1015', '1001', 'earlier', 'observation', '踩踏面与表土关系待核'],
    // 将被撤回的旧版推断
    ['R12', '1015', '1003', 'earlier', 'inference', '旧版手填推断：踩踏面被淤积层覆盖'],
  ]

  const relations: Relation[] = raw.map(([id, from, to, kind, source, note], i) => ({
    id,
    from,
    to,
    kind,
    source,
    status: 'active',
    conflict: false,
    evidenceIds: [],
    note,
    createdAt: now + i,
  }))

  const day = new Date(now).toISOString().slice(0, 10)
  const evidences: Evidence[] = [
    { id: 'E1', relationId: 'R1', type: 'diary', note: '1003 淤积层被 1001 表土直接覆盖，界面清晰。', collectedAt: day, attachment: null, createdAt: now + 100 },
    { id: 'E2', relationId: 'R2', type: 'diary', note: '居住面 1007 之上直接叠压 1003 淤积层。', collectedAt: day, attachment: null, createdAt: now + 101 },
    {
      id: 'E3',
      relationId: 'R3',
      type: 'section',
      note: '剖面图 S-04：基槽 1006 切穿居住面 1007。',
      collectedAt: day,
      attachment: { id: 'A3', name: 'section-S-04.svg', mime: 'image/svg+xml', size: 0 },
      createdAt: now + 102,
    },
    // R4：采纳与驳回并存（未解决否决 → 关系不生效）
    { id: 'E4a', relationId: 'R4', type: 'photo', note: '照片 IMG_2031：填土晚于切割迹象。', collectedAt: day, attachment: null, createdAt: now + 103 },
    { id: 'E4b', relationId: 'R4', type: 'survey', note: '测绘卡#11：填土与切割时序存疑，反对采纳。', collectedAt: day, attachment: null, createdAt: now + 104 },
    { id: 'E5', relationId: 'R6', type: 'photo', note: '灰坑 1010 剖面：坑口切过陶片层 1012。', collectedAt: day, attachment: null, createdAt: now + 105 },
    { id: 'E6', relationId: 'R7', type: 'photo', note: '坑内填土 1009 晚于坑的切割 1010。', collectedAt: day, attachment: null, createdAt: now + 106 },
    { id: 'E7', relationId: 'R9', type: 'photo', note: '陶片层与踩踏面为同一期活动面。', collectedAt: day, attachment: null, createdAt: now + 107 },
    // R10：待复核时无环；采纳后与 R6/R7 冲突
    { id: 'E8', relationId: 'R10', type: 'survey', note: '记录员乙·地层卡#7：认为 1009 早于 1012（与剖面观察矛盾）。', collectedAt: day, attachment: null, createdAt: now + 108 },
    // R11：待复核 + 附件本机缺失（有元数据、无 Blob）
    {
      id: 'E9',
      relationId: 'R11',
      type: 'photo',
      note: '据称有照片显示 1015 早于 1001，但附件本机缺失。',
      collectedAt: day,
      attachment: { id: 'A9-MISSING', name: 'IMG_missing.jpg', mime: 'image/jpeg', size: 248120 },
      createdAt: now + 109,
    },
  ]

  const reviews: ReviewRecord[] = [
    { id: 'V1', seq: 1, evidenceId: 'E1', action: 'adopt', operator: '甲', comment: '日记与现场吻合，采纳。', at: now + 200, fromStatus: 'pending', toStatus: 'accepted', undone: false },
    { id: 'V2', seq: 2, evidenceId: 'E2', action: 'adopt', operator: '甲', comment: '采纳。', at: now + 201, fromStatus: 'pending', toStatus: 'accepted', undone: false },
    { id: 'V3', seq: 3, evidenceId: 'E3', action: 'adopt', operator: '甲', comment: '剖面图证据充分，采纳。', at: now + 202, fromStatus: 'pending', toStatus: 'accepted', undone: false },
    { id: 'V4a', seq: 4, evidenceId: 'E4a', action: 'adopt', operator: '甲', comment: '照片看起来支持。', at: now + 203, fromStatus: 'pending', toStatus: 'accepted', undone: false },
    { id: 'V4b', seq: 5, evidenceId: 'E4b', action: 'reject', operator: '乙', comment: '时序判断依据不足，驳回照片结论。', at: now + 204, fromStatus: 'accepted', toStatus: 'rejected', undone: false },
    { id: 'V5', seq: 6, evidenceId: 'E5', action: 'adopt', operator: '甲', comment: '采纳。', at: now + 205, fromStatus: 'pending', toStatus: 'accepted', undone: false },
    { id: 'V6', seq: 7, evidenceId: 'E6', action: 'adopt', operator: '甲', comment: '采纳。', at: now + 206, fromStatus: 'pending', toStatus: 'accepted', undone: false },
    { id: 'V7', seq: 8, evidenceId: 'E7', action: 'adopt', operator: '甲', comment: '同期关联，采纳存档。', at: now + 207, fromStatus: 'pending', toStatus: 'accepted', undone: false },
    // R10：曾被采纳又撤销（撤销最近一次复核的演示，历史保留）；当前待复核，矩阵无环
    { id: 'V8', seq: 9, evidenceId: 'E8', action: 'adopt', operator: '乙', comment: '我坚持我的判断。', at: now + 208, fromStatus: 'pending', toStatus: 'accepted', undone: true },
  ]

  // 仅 E3 有真实附件内容；E9 故意只有元数据，制造“附件缺失但不阻断加载”
  const svgBytes = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="60"><text x="6" y="36">S-04 剖面示意</text></svg>',
  )
  const attachments: AttachmentBlob[] = [{ id: 'A3', name: 'section-S-04.svg', mime: 'image/svg+xml', bytes: svgBytes }]

  // 撤回最后一条旧版推断，并留下独立的撤销记录
  const retracted = relations[relations.length - 1]
  const snapshot: Relation = { ...retracted }
  retracted.status = 'retracted'
  const retractions: Retraction[] = [
    {
      id: 'X1',
      relationId: retracted.id,
      snapshot,
      reason: '剖面复核后 1015 与 1003 的叠压关系不明，撤回该推断。',
      at: now + 300,
    },
  ]

  return { units, evidences, reviews, attachments, relations, retractions }
}
