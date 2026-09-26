<script setup lang="ts">
import { state, undoReview } from '../store'

const reviewStatusNames: Record<string, string> = {
  pending: '待复核',
  accepted: '已采纳',
  rejected: '已驳回',
}

function fmtTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <section class="panel">
    <h3>
      复核审计链（{{ state.reviews.length }}）
      <button
        v-if="state.reviews.some(r => !r.undone)"
        class="sm"
        style="float: right"
        title="撤销全局最近一次复核（仅追加撤销记录，历史不删除）"
        @click="undoReview()"
      >
        撤销最近复核
      </button>
    </h3>
    <ul class="list">
      <li v-for="v in [...state.reviews].reverse()" :key="v.id" :class="{ undone: v.undone }">
        <span class="grow">
          <span class="tag" :class="v.undone ? 'hidden' : v.toStatus">
            {{ v.undone ? '撤销' : reviewStatusNames[v.toStatus] }}
          </span>
          <b>{{ v.operator }}</b>
          <small class="muted">　{{ fmtTime(v.at) }}</small>
          <br />
          <small>{{ v.relationLabel || v.relationId }}｜{{ v.evidenceRef }}</small>
          <br />
          <small class="muted">
            {{ reviewStatusNames[v.fromStatus] }} → {{ reviewStatusNames[v.toStatus] }}　意见：{{ v.comment }}
          </small>
        </span>
      </li>
      <li v-if="state.reviews.length === 0" class="muted">暂无复核记录</li>
    </ul>
  </section>

  <section class="panel">
    <h3>操作批次（{{ state.batches.length }}）</h3>
    <ul class="list">
      <li v-for="b in [...state.batches].reverse()" :key="b.id" :class="{ undone: b.undone }">
        <span class="grow" :class="{ undone: b.undone }">
          {{ b.label }}
          <br />
          <small class="muted">{{ fmtTime(b.at) }}　{{ b.mutations.length }} 项变更</small>
        </span>
        <span v-if="b.undone" class="tag hidden">已撤销</span>
      </li>
      <li v-if="state.batches.length === 0" class="muted">暂无操作</li>
    </ul>
  </section>
</template>

<style scoped>
.undone {
  text-decoration: line-through;
  opacity: 0.6;
}
.tag.accepted { border-color: #2e7d32; color: #2e7d32; }
.tag.rejected { border-color: #c62828; color: #c62828; }
</style>
