<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import MatrixCanvas from './components/MatrixCanvas.vue'
import UnitPanel from './components/UnitPanel.vue'
import RelationPanel from './components/RelationPanel.vue'
import BatchPanel from './components/BatchPanel.vue'
import ReviewDialog from './components/ReviewDialog.vue'
import {
  autoLayout,
  clearAll,
  evidenceById,
  exportProject,
  importProject,
  lastBatch,
  lastReview,
  loadSample,
  redundantIds,
  refresh,
  state,
  undo,
  undoReview,
  unitLabel,
} from './store'

const fileInput = ref<HTMLInputElement>()

const missingList = computed(() =>
  [...state.missingAttachmentIds]
    .map((id) => evidenceById(id))
    .filter((e): e is NonNullable<typeof e> => !!e && !!e.attachment),
)

onMounted(() => {
  void refresh()
})

function onImportFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) void importProject(file)
  if (fileInput.value) fileInput.value.value = ''
}
</script>

<template>
  <div class="app">
    <header class="toolbar">
      <h1>地层矩阵编辑台</h1>
      <div class="view-toggle" role="tablist">
        <button :class="{ on: state.viewMode === 'raw' }" @click="state.viewMode = 'raw'">原始关系</button>
        <button :class="{ on: state.viewMode === 'simplified' }" @click="state.viewMode = 'simplified'">
          简化视图
        </button>
      </div>
      <span v-if="state.viewMode === 'simplified'" class="muted small light">
        已隐藏 {{ redundantIds.size }} 条传递边（原始记录保留）
      </span>
      <span class="spacer"></span>
      <button @click="autoLayout">自动分层排布</button>
      <button
        :disabled="!lastReview"
        :title="lastReview ? `撤销最近复核：${lastReview.operator} 的${lastReview.action === 'adopt' ? '采纳' : '驳回'}` : '没有可撤销的复核'"
        @click="undoReview"
      >
        撤销最近复核{{ lastReview ? `（${lastReview.operator}）` : '' }}
      </button>
      <button :disabled="!lastBatch" :title="lastBatch ? `撤销：${lastBatch.label}` : '没有可撤销的操作'" @click="undo">
        撤销批次{{ lastBatch ? `：${lastBatch.label}` : '' }}
      </button>
      <button @click="loadSample">载入示例</button>
      <button @click="exportProject" :disabled="state.units.length === 0">导出工程</button>
      <button @click="fileInput?.click()">导入…</button>
      <input ref="fileInput" type="file" accept="application/json" hidden @change="onImportFile" />
      <button class="danger" @click="clearAll()">清空</button>
    </header>

    <!-- 缺失附件提示：显式列出，但绝不阻断工程加载 -->
    <div v-if="missingList.length" class="missing-banner">
      ⚠ 本机有 {{ missingList.length }} 个附件内容缺失（元数据仍在，可重新登记）：
      <span v-for="ev in missingList" :key="ev.id" class="missing-item">
        {{ ev.attachment!.name }}（{{ unitLabel(state.relations.find((r) => r.id === ev.relationId)?.from ?? '') }}
        →{{ unitLabel(state.relations.find((r) => r.id === ev.relationId)?.to ?? '') }}）
      </span>
    </div>

    <main class="main">
      <aside class="sidebar">
        <UnitPanel />
        <RelationPanel />
        <BatchPanel />
      </aside>
      <MatrixCanvas />
    </main>

    <footer class="statusbar">
      数据仅保存于本机浏览器 IndexedDB（含附件内容），不上传任何现场资料。只有≥1 条已采纳证据且无未解决否决的原始观察进入有效偏序；推断关系随有效观察集实时重算；复核可撤销但审计链不删除。
    </footer>

    <ReviewDialog />

    <div v-if="state.toast" class="toast">{{ state.toast }}</div>
  </div>
</template>

<style scoped>
.light {
  color: #d8cfc4;
}
.missing-banner {
  background: #fff3e0;
  border-bottom: 1px solid #f0b27a;
  color: #b3541e;
  font-size: 12px;
  padding: 5px 12px;
}
.missing-item {
  margin-left: 8px;
  font-weight: 600;
}
</style>
