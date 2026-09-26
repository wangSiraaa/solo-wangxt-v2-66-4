<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { cancelReview, evidenceById, state, statusOf, submitReview, unitLabel } from '../store'

const form = reactive({ operator: (localStorage.getItem('hm-reviewer') as string) || '', comment: '' })

const ev = computed(() => (state.pendingReview ? evidenceById(state.pendingReview.evidenceId) : undefined))
const rel = computed(() =>
  ev.value ? state.relations.find((r) => r.id === ev.value!.relationId) : undefined,
)
const statusNames = { pending: '待复核', accepted: '已采纳', rejected: '已驳回' } as const

function submit() {
  if (form.operator.trim()) localStorage.setItem('hm-reviewer', form.operator.trim())
  void submitReview(form.operator, form.comment)
  form.comment = ''
}

watch(
  () => state.pendingReview,
  (p) => {
    if (p) form.comment = ''
  },
)
</script>

<template>
  <div v-if="state.pendingReview && ev" class="modal-mask" @click.self="cancelReview">
    <div class="modal">
      <h3 :class="state.pendingReview.action === 'adopt' ? 'adopt' : 'reject'">
        {{ state.pendingReview.action === 'adopt' ? '采纳证据' : '驳回证据' }}
      </h3>
      <p v-if="rel" class="muted small">
        关系：{{ unitLabel(rel.from) }} 早于 {{ unitLabel(rel.to) }}
      </p>
      <p>
        证据说明：{{ ev.note || '（无）' }}<br />
        当前状态：{{ statusNames[statusOf(ev.id)] }}
      </p>
      <form class="form" @submit.prevent="submit">
        <input v-model="form.operator" placeholder="操作者名称（必填，留空记为匿名记录员）" />
        <textarea v-model="form.comment" rows="3" placeholder="复核意见（采纳/驳回依据）"></textarea>
        <div class="modal-actions">
          <button type="submit" :class="state.pendingReview.action === 'reject' ? 'danger' : ''">
            确认{{ state.pendingReview.action === 'adopt' ? '采纳' : '驳回' }}
          </button>
          <button type="button" @click="cancelReview">取消</button>
        </div>
      </form>
      <p class="hint">复核会记录操作者、时间、意见与前后状态；可在工具条「撤销最近复核」中回滚，审计记录不删除。</p>
    </div>
  </div>
</template>

<style scoped>
.adopt {
  color: #2e7d32;
}
.reject {
  color: #c62828;
}
textarea {
  border: 1px solid #ccc;
  border-radius: 5px;
  padding: 5px 8px;
  font-size: 13px;
  width: 100%;
  font-family: inherit;
  resize: vertical;
}
.hint {
  font-size: 12px;
  color: #888;
  margin: 8px 0 0;
}
</style>
