<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import {
  downloadEvidenceAttachment,
  evidenceOfRelation,
  reviewsOf,
  startReview,
  state,
  statusOf,
  unitLabel,
  addEvidence,
} from '../store'
import type { EvidenceType, Relation } from '../types'

const props = defineProps<{ relation: Relation }>()

const typeNames: Record<EvidenceType, string> = {
  photo: '照片',
  section: '剖面图',
  diary: '田野日记',
  survey: '测绘记录',
  other: '其他',
}

const statusNames = { pending: '待复核', accepted: '已采纳', rejected: '已驳回' } as const

const adding = reactive({ open: false, type: 'diary' as EvidenceType, note: '', collectedAt: '', fileName: '' })
const fileInput = ref<HTMLInputElement | null>(null)
let pickedFile: File | null = null

const evidences = computed(() => evidenceOfRelation(props.relation.id))

function pickFile(e: Event) {
  pickedFile = (e.target as HTMLInputElement).files?.[0] ?? null
  adding.fileName = pickedFile?.name ?? ''
}

async function submitEvidence() {
  await addEvidence({
    relationId: props.relation.id,
    type: adding.type,
    note: adding.note,
    collectedAt: adding.collectedAt,
    file: pickedFile,
  })
  adding.open = false
  adding.note = ''
  adding.collectedAt = ''
  adding.fileName = ''
  pickedFile = null
  if (fileInput.value) fileInput.value.value = ''
}

function fmt(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

function isMissing(evId: string): boolean {
  return state.missingAttachmentIds.has(evId)
}

const fromTo = computed(() => `${unitLabel(props.relation.from)}→${unitLabel(props.relation.to)}`)
</script>

<template>
  <div class="ev-block">
    <ul class="ev-list">
      <li v-for="ev in evidences" :key="ev.id" class="ev-item">
        <div class="ev-head">
          <span class="ev-type">{{ typeNames[ev.type] }}</span>
          <span class="ev-date">{{ ev.collectedAt || '未填采集日期' }}</span>
          <span class="ev-status" :class="statusOf(ev.id)">{{ statusNames[statusOf(ev.id)] }}</span>
          <span class="spacer"></span>
          <button
            class="sm"
            :class="{ on: statusOf(ev.id) === 'accepted' }"
            title="提交采纳复核"
            @click="startReview(ev.id, 'adopt')"
          >
            采纳
          </button>
          <button
            class="sm danger"
            :class="{ on: statusOf(ev.id) === 'rejected' }"
            title="提交驳回复核"
            @click="startReview(ev.id, 'reject')"
          >
            驳回
          </button>
        </div>
        <div v-if="ev.note" class="ev-note">{{ ev.note }}</div>
        <div v-if="ev.attachment" class="ev-att">
          📎 {{ ev.attachment.name }}
          <span class="muted small">（{{ (ev.attachment.size / 1024).toFixed(1) }} KB）</span>
          <button v-if="!isMissing(ev.id)" class="sm" @click="downloadEvidenceAttachment(ev)">打开/下载</button>
          <strong v-else class="missing" :title="`证据属于关系 ${fromTo}`">附件在本机缺失</strong>
        </div>
        <details class="audit">
          <summary>复核记录（{{ reviewsOf(ev.id).length }}）</summary>
          <ol class="audit-list">
            <li v-for="v in reviewsOf(ev.id)" :key="v.id" :class="{ undone: v.undone }">
              <b>{{ v.operator }}</b>
              {{ v.action === 'adopt' ? '采纳' : '驳回' }}
              <span class="muted small">
                {{ statusNames[v.fromStatus] }} → {{ statusNames[v.toStatus] }}，{{ fmt(v.at) }}
              </span>
              <span v-if="v.undone" class="tag hidden">已撤销</span>
              <div class="muted small">意见：{{ v.comment }}</div>
            </li>
          </ol>
        </details>
      </li>
      <li v-if="evidences.length === 0" class="muted small">尚无证据（无证据的观察不进入矩阵）</li>
    </ul>

    <button class="sm add-ev" @click="adding.open = !adding.open">
      {{ adding.open ? '收起' : '＋ 添加证据（待复核）' }}
    </button>
    <form v-if="adding.open" class="ev-form" @submit.prevent="submitEvidence">
      <div class="row">
        <select v-model="adding.type">
          <option v-for="(name, t) in typeNames" :key="t" :value="t">{{ name }}</option>
        </select>
        <input v-model="adding.collectedAt" type="date" required />
      </div>
      <input v-model="adding.note" placeholder="证据说明" required />
      <div class="row">
        <input ref="fileInput" type="file" @change="pickFile" />
      </div>
      <small v-if="adding.fileName" class="muted">已选附件：{{ adding.fileName }}（内容仅存本机浏览器）</small>
      <button type="submit" class="sm">登记为待复核证据</button>
    </form>
  </div>
</template>

<style scoped>
.ev-block {
  margin-top: 4px;
  border-left: 3px solid #d8cfc4;
  padding-left: 8px;
}
.ev-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 4px 0;
}
.ev-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: #faf8f5;
  border: 1px solid #ece5d9;
  border-radius: 6px;
  padding: 4px 8px;
}
.ev-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.spacer {
  flex: 1;
}
.ev-type {
  font-size: 11px;
  background: #6d5c47;
  color: #fff;
  border-radius: 4px;
  padding: 0 6px;
}
.ev-date {
  font-size: 11px;
  color: #888;
}
.ev-status {
  font-size: 11px;
  border-radius: 4px;
  padding: 0 6px;
  border: 1px solid #bbb;
  color: #666;
}
.ev-status.pending {
  border-color: #f9a825;
  color: #f9a825;
}
.ev-status.accepted {
  border-color: #2e7d32;
  color: #2e7d32;
}
.ev-status.rejected {
  border-color: #c62828;
  color: #c62828;
}
button.on {
  font-weight: 700;
}
.ev-note {
  font-size: 12px;
}
.ev-att {
  font-size: 12px;
}
.missing {
  color: #c62828;
  font-size: 11px;
}
.audit {
  margin-top: 2px;
}
.audit summary {
  font-size: 11px;
  color: #888;
  cursor: pointer;
}
.audit-list {
  margin: 4px 0;
  padding-left: 18px;
  font-size: 12px;
}
.audit-list li.undone {
  opacity: 0.55;
}
.add-ev {
  margin-top: 2px;
}
.ev-form {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
}
</style>
