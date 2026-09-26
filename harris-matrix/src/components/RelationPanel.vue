<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import {
  activeRelations,
  addEvidence,
  addRelation,
  conflictCycles,
  conflictIds,
  evidenceBucket,
  evidenceStatus,
  evidenceTypeNames,
  inferredEdges,
  legacyInferenceRelations,
  openAttachment,
  redundantIds,
  relationLabel,
  retractRelation,
  reviewEvidence,
  reviewStatusNames,
  setOperator,
  state,
  undoReview,
  unitLabel,
} from '../store'
import type { Evidence, EvidenceDraft, EvidenceType, Relation, RelationKind } from '../types'

const form = reactive({ from: '', to: '', kind: 'earlier' as RelationKind, note: '' })

/* 每条关系内联的“追加证据”表单 */
const expanded = ref<string | null>(null)
const evDraft = reactive<{ type: EvidenceType; text: string; collectedAt: string }>({
  type: 'diary',
  text: '',
  collectedAt: '',
})
let pickedFile: File | null = null
const fileInput = ref<HTMLInputElement>()

/* 每条证据最近一条复核（用于展示操作者/意见） */
function lastReviewOf(evId: string) {
  let last = null as null | (typeof state.reviews)[number]
  for (const v of state.reviews) if (v.evidenceId === evId && !v.undone) last = v
  return last
}

function describe(r: Relation): string {
  return relationLabel(r)
}

function statusTag(r: Relation): { text: string; cls: string } | null {
  if (r.status !== 'active') return null
  const b = evidenceBucket(r.id)
  if (b.accepted.length === 0) return { text: '待复核', cls: 'pending' }
  if (b.rejected.length > 0) return { text: '已否决', cls: 'rejected' }
  if (conflictIds.value.has(r.id)) return { text: '矛盾', cls: 'conflict' }
  return { text: '有效', cls: 'valid' }
}

function isHidden(r: Relation): boolean {
  return state.viewMode === 'simplified' && redundantIds.value.has(r.id)
}

function fmtTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

async function submit() {
  await addRelation({ from: form.from, to: form.to, kind: form.kind, note: form.note })
  form.note = ''
}

function retract(r: Relation) {
  const reason = window.prompt(`撤回「${describe(r)}」的理由：`)
  if (reason !== null) void retractRelation(r.id, reason)
}

function toggleEvForm(r: Relation) {
  if (expanded.value === r.id) {
    expanded.value = null
    return
  }
  expanded.value = r.id
  evDraft.type = 'diary'
  evDraft.text = ''
  evDraft.collectedAt = new Date().toISOString().slice(0, 10)
  pickedFile = null
  if (fileInput.value) fileInput.value.value = ''
}

function onFile(e: Event) {
  pickedFile = (e.target as HTMLInputElement).files?.[0] ?? null
}

async function submitEvidence(r: Relation) {
  const draft: EvidenceDraft = {
    type: evDraft.type,
    text: evDraft.text,
    collectedAt: evDraft.collectedAt,
    attachment: null,
  }
  if (pickedFile) {
    const buf = await pickedFile.arrayBuffer()
    draft.attachment = {
      meta: {
        id: crypto.randomUUID(),
        name: pickedFile.name,
        mime: pickedFile.type || 'application/octet-stream',
        size: pickedFile.size,
      },
      blob: new Blob([buf], { type: pickedFile.type || 'application/octet-stream' }),
    }
  }
  await addEvidence(r.id, draft)
  expanded.value = null
  pickedFile = null
}

function review(ev: Evidence, to: 'accepted' | 'rejected') {
  const verb = to === 'accepted' ? '采纳' : '驳回'
  const comment = window.prompt(`复核意见（${verb}「${evidenceTypeNames[ev.type]}」证据，操作者：${state.operator || '（未设置）'}）：`)
  if (comment !== null) void reviewEvidence(ev.id, to, comment)
}

function attachmentState(ev: Evidence): 'none' | 'ok' | 'missing' {
  if (!ev.attachment) return 'none'
  return state.attachments[ev.attachment.id] ? 'ok' : 'missing'
}

/* 列表排序：有效在前，其次待复核/否决/矛盾 */
const orderedActive = computed(() => {
  const rank = (r: Relation) => {
    const t = statusTag(r)
    return t?.cls === 'valid' ? 0 : t?.cls === 'conflict' ? 1 : 2
  }
  return [...activeRelations.value].sort((a, b) => rank(a) - rank(b))
})

const cycleList = computed(() =>
  [...conflictCycles.value.entries()].map(([id, path]) => ({
    id,
    path: path.map(unitLabel).join(' → '),
  })),
)

function evId(ev: Evidence) {
  return ev.id
}
</script>

<template>
  <section class="panel">
    <h3>新增原始观察</h3>
    <form class="form" @submit.prevent="submit">
      <div class="row">
        <select v-model="form.from" required>
          <option value="" disabled>起点层位</option>
          <option v-for="u in state.units" :key="u.id" :value="u.id">{{ u.label }}</option>
        </select>
        <select v-model="form.kind">
          <option value="earlier">早于（有向）</option>
          <option value="contemporary">同期（无向）</option>
        </select>
        <select v-model="form.to" required>
          <option value="" disabled>终点层位</option>
          <option v-for="u in state.units" :key="u.id" :value="u.id">{{ u.label }}</option>
        </select>
      </div>
      <input v-model="form.note" placeholder="观察说明（可选）" />
      <button type="submit">登记观察</button>
      <p class="hint">登记后为“待复核”，须至少一条证据被采纳且无未解决驳回，才进入矩阵与偏序计算。</p>
    </form>
    <label class="operator">
      操作者：
      <input :value="state.operator" placeholder="复核将记录此名称" @input="setOperator(($event.target as HTMLInputElement).value)" />
    </label>
  </section>

  <section class="panel">
    <h3>
      原始观察与证据（{{ orderedActive.length }}）
      <span class="muted small">有效 {{ state.relations.filter(r => statusTag(r)?.cls === 'valid').length }}</span>
    </h3>
    <ul class="list relations">
      <li v-for="r in orderedActive" :key="r.id" class="relation" :class="{ faded: isHidden(r) }">
        <div class="rel-head">
          <span class="grow">
            <b>{{ describe(r) }}</b>
            <span v-if="r.kind === 'contemporary'" class="tag contemp">无向</span>
            <span v-if="statusTag(r)" class="tag" :class="statusTag(r)!.cls">{{ statusTag(r)!.text }}</span>
            <span v-if="isHidden(r)" class="tag hidden">简化视图中隐藏</span>
            <small v-if="r.note" class="muted"><br />{{ r.note }}</small>
          </span>
          <span class="rel-actions">
            <button class="sm" @click="toggleEvForm(r)">{{ expanded === r.id ? '收起' : '+证据' }}</button>
            <button class="sm danger" title="撤回该判断" @click="retract(r)">撤回</button>
          </span>
        </div>

        <ul v-if="evidenceBucket(r.id).accepted.length || evidenceBucket(r.id).rejected.length || evidenceBucket(r.id).pending.length" class="evlist">
          <li v-for="ev in [...evidenceBucket(r.id).accepted, ...evidenceBucket(r.id).rejected, ...evidenceBucket(r.id).pending]" :key="ev.id">
            <span class="ev-status" :class="evidenceStatus(ev.id)">{{ reviewStatusNames[evidenceStatus(ev.id)] }}</span>
            <span class="grow ev-body">
              <b>{{ evidenceTypeNames[ev.type] }}</b>
              <span v-if="ev.collectedAt" class="muted small">　采集于 {{ ev.collectedAt }}</span>
              <br />
              <small>{{ ev.text || '（无说明）' }}</small>
              <small v-if="attachmentState(ev) === 'ok'" class="att ok">📎 {{ ev.attachment!.name }}
                <button class="sm" @click="openAttachment(ev)">打开</button>
              </small>
              <small v-else-if="attachmentState(ev) === 'missing'" class="att missing">
                ⚠️ 附件「{{ ev.attachment!.name }}」本地缺失（元数据保留，不影响工程加载）
              </small>
              <small v-if="lastReviewOf(evId(ev))" class="muted review-line">
                <br />最近复核：{{ lastReviewOf(evId(ev))!.operator }} · {{ fmtTime(lastReviewOf(evId(ev))!.at) }} · {{ lastReviewOf(evId(ev))!.comment }}
              </small>
            </span>
            <span class="ev-actions">
              <button class="sm" :disabled="evidenceStatus(ev.id) === 'accepted' || !state.operator.trim()" @click="review(ev, 'accepted')">采纳</button>
              <button class="sm danger" :disabled="evidenceStatus(ev.id) === 'rejected' || !state.operator.trim()" @click="review(ev, 'rejected')">驳回</button>
              <button class="sm" title="撤销该证据最近一次复核（历史保留）" @click="undoReview(ev.id)">撤销复核</button>
            </span>
          </li>
        </ul>
        <p v-else class="muted small no-ev">尚无证据，不进入偏序计算。</p>

        <form v-if="expanded === r.id" class="form evform" @submit.prevent="submitEvidence(r)">
          <div class="row">
            <select v-model="evDraft.type">
              <option v-for="(name, t) in evidenceTypeNames" :key="t" :value="t">{{ name }}</option>
            </select>
            <input type="date" v-model="evDraft.collectedAt" required />
          </div>
          <input v-model="evDraft.text" placeholder="证据说明（可选）" />
          <input ref="fileInput" type="file" @change="onFile" />
          <div class="row">
            <button type="submit">追加证据</button>
          </div>
        </form>
      </li>
      <li v-if="orderedActive.length === 0" class="muted">暂无关系</li>
    </ul>
  </section>

  <section v-if="cycleList.length" class="panel conflict-panel">
    <h3>复核冲突（{{ cycleList.length }}）</h3>
    <p class="hint">以下关系的采纳决定已保留，但与既有有效观察构成环，不进入偏序计算；驳回其证据或撤销复核可解除。</p>
    <ul class="list">
      <li v-for="c in cycleList" :key="c.id">
        <span class="grow"><span class="tag conflict">矛盾</span> <span class="cycle-path">{{ c.path }}</span></span>
      </li>
    </ul>
  </section>

  <section class="panel">
    <h3>推断结论（{{ inferredEdges.length }}，随有效观察实时重算）</h3>
    <ul class="list">
      <li v-for="e in inferredEdges" :key="e.id" class="inferred">
        <span class="grow">
          {{ unitLabel(e.from) }} 早于 {{ unitLabel(e.to) }}
          <small class="muted"><br />传递路径：{{ e.path.map(unitLabel).join(' → ') }}</small>
        </span>
        <span class="tag inference">推断</span>
      </li>
      <li v-if="inferredEdges.length === 0" class="muted">暂无传递结论</li>
    </ul>
  </section>

  <section class="panel">
    <h3>已撤回判断（{{ state.retractions.length }}）</h3>
    <ul class="list">
      <li v-for="x in state.retractions" :key="x.id" class="retracted">
        <span class="grow">
          <s>{{ describe(x.snapshot) }}</s>
          <br />
          <small class="muted">{{ fmtTime(x.at) }}　理由：{{ x.reason }}</small>
        </span>
      </li>
      <li v-if="state.retractions.length === 0" class="muted">暂无</li>
    </ul>
  </section>

  <section v-if="legacyInferenceRelations.length" class="panel">
    <h3>历史推断记录（{{ legacyInferenceRelations.length }}，仅存档）</h3>
    <ul class="list">
      <li v-for="r in legacyInferenceRelations" :key="r.id">
        <span class="grow"><s>{{ describe(r) }}</s><small class="muted">　推断已改为由有效观察实时派生</small></span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.faded {
  opacity: 0.45;
}
.retracted {
  background: #faf3f3;
}
.inferred {
  background: #fff8ec;
}
.operator {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #6d5c47;
  margin-top: 6px;
}
.relations .relation {
  display: block;
}
.rel-head {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.rel-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.evlist {
  list-style: none;
  margin: 6px 0 0;
  padding: 6px 0 0 8px;
  border-left: 3px solid #e3ddd3;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.evlist > li {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 4px 6px;
  background: #f8f6f2;
}
.ev-status {
  font-size: 11px;
  border-radius: 4px;
  padding: 1px 6px;
  flex-shrink: 0;
  border: 1px solid #999;
  color: #666;
}
.ev-status.accepted { border-color: #2e7d32; color: #2e7d32; background: #eef7ee; }
.ev-status.rejected { border-color: #c62828; color: #c62828; background: #fdeeec; }
.ev-status.pending { border-color: #f9a825; color: #b26a00; background: #fff8e6; }
.ev-actions {
  display: flex;
  gap: 3px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.ev-body {
  font-size: 12px;
}
.att {
  display: inline-block;
  margin-left: 6px;
}
.att.ok { color: #2e7d32; }
.att.missing { color: #c62828; font-weight: 600; }
.review-line {
  display: block;
}
.evform {
  margin-top: 6px;
  background: #faf8f5;
  padding: 6px;
  border-radius: 6px;
}
.no-ev {
  margin: 4px 0 0 8px;
}
.hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: #888;
}
.cycle-path {
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
.conflict-panel {
  border-color: #f5c6c0;
}
.tag.valid { border-color: #2e7d32; color: #2e7d32; }
.tag.pending { border-color: #f9a825; color: #b26a00; }
.tag.rejected { border-color: #c62828; color: #c62828; }
</style>
