<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import MatrixCanvas from './components/MatrixCanvas.vue'
import UnitPanel from './components/UnitPanel.vue'
import RelationPanel from './components/RelationPanel.vue'
import BatchPanel from './components/BatchPanel.vue'
import {
  autoLayout,
  clearAll,
  exportProject,
  importProject,
  lastBatch,
  loadSample,
  redundantIds,
  refresh,
  state,
  undo,
} from './store'

const fileInput = ref<HTMLInputElement>()

const missingNames = computed(() =>
  state.missingAttachments.map((e) => e.attachment?.name).filter((n): n is string => Boolean(n)),
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
      <span v-if="state.viewMode === 'simplified'" class="muted small">
        已隐藏 {{ redundantIds.size }} 条传递边（原始记录保留）
      </span>
      <span class="spacer"></span>
      <button @click="autoLayout">自动分层排布</button>
      <button :disabled="!lastBatch" :title="lastBatch ? `撤销：${lastBatch.label}` : '没有可撤销的操作'" @click="undo">
        撤销{{ lastBatch ? `：${lastBatch.label}` : '' }}
      </button>
      <button @click="loadSample">载入示例</button>
      <button @click="exportProject" :disabled="state.units.length === 0">导出工程</button>
      <button @click="fileInput?.click()">导入…</button>
      <input ref="fileInput" type="file" accept="application/json" hidden @change="onImportFile" />
      <button class="danger" @click="clearAll()">清空</button>
    </header>

    <div v-if="missingNames.length" class="missing-banner">
      ⚠️ {{ missingNames.length }} 个附件在浏览器本地缺失（{{ missingNames.slice(0, 3).join('、')
      }}{{ missingNames.length > 3 ? ' 等' : '' }}）：证据元数据与审计链完整保留，工程可正常使用，请在现场重新采集附件。
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
      数据仅保存于本机浏览器 IndexedDB（含附件内容），不上传任何现场资料。原始观察须证据复核通过（至少一条已采纳且无未解决驳回、不成环）才进入有效偏序；推断结论随有效观察集实时重算；复核记录不可删除，只能追加撤销。
    </footer>

    <div v-if="state.toast" class="toast">{{ state.toast }}</div>
  </div>
</template>
