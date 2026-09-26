<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import cytoscape from 'cytoscape'
import {
  activeRelations,
  conflictInfo,
  gateState,
  inferredEdges,
  matrixEdges,
  orderEdges,
  redundantIds,
  savePosition,
  state,
} from '../store'
import { layeredPositions } from '../graph'

const el = ref<HTMLElement>()
let cy: cytoscape.Core | null = null

const style: cytoscape.StylesheetJson = [
  {
    selector: 'node',
    style: {
      label: 'data(label)',
      'text-valign': 'bottom',
      'text-margin-y': 6,
      'font-size': 11,
      color: '#222',
      width: 36,
      height: 36,
      'background-color': '#90a4ae',
      'border-width': 2,
      'border-color': '#ffffff',
    },
  },
  { selector: 'node[type="deposit"]', style: { 'background-color': '#8d6e63', shape: 'round-rectangle' } },
  { selector: 'node[type="fill"]', style: { 'background-color': '#ffb300', shape: 'round-rectangle' } },
  { selector: 'node[type="cut"]', style: { 'background-color': '#e53935', shape: 'diamond' } },
  { selector: 'node[type="interface"]', style: { 'background-color': '#607d8b', shape: 'ellipse' } },
  { selector: 'node.isolated', style: { 'border-color': '#ab47bc', 'border-width': 3, 'border-style': 'dashed' } },
  { selector: 'node.selected', style: { 'border-color': '#1e88e5', 'border-width': 4 } },
  {
    selector: 'edge',
    style: {
      width: 2,
      'line-color': '#2e7d32',
      'target-arrow-shape': 'triangle',
      'target-arrow-color': '#2e7d32',
      'curve-style': 'bezier',
      'arrow-scale': 1.2,
    },
  },
  /* 实时导出的推断关系：橙色虚线 */
  {
    selector: 'edge.inferred',
    style: {
      'line-style': 'dashed',
      'line-color': '#ef6c00',
      'target-arrow-color': '#ef6c00',
      label: '推断',
      'font-size': 10,
      color: '#ef6c00',
      'text-rotation': 'autorotate',
    },
  },
  /* 采纳后构成环：保留复核决定，红色虚线冲突 */
  {
    selector: 'edge.conflict',
    style: {
      'line-color': '#d32f2f',
      'target-arrow-color': '#d32f2f',
      'line-style': 'dashed',
      label: '环冲突',
      'font-size': 10,
      color: '#d32f2f',
      'text-rotation': 'autorotate',
    },
  },
  /* 尚未生效（待复核 / 未解决否决）的原始观察：灰点线，不参与布局与计算 */
  {
    selector: 'edge.noneffective',
    style: {
      'line-style': 'dotted',
      'line-color': '#bdbdbd',
      'target-arrow-color': '#bdbdbd',
      opacity: 0.6,
      label: 'data(stateLabel)',
      'font-size': 9,
      color: '#9e9e9e',
      'text-rotation': 'autorotate',
    },
  },
  {
    selector: 'edge.contemporary',
    style: {
      'line-style': 'dotted',
      'line-color': '#7e57c2',
      'target-arrow-shape': 'none',
      'target-arrow-color': '#7e57c2',
      label: '同期',
      'font-size': 10,
      color: '#7e57c2',
      'text-rotation': 'autorotate',
    },
  },
]

function rebuild() {
  if (!cy) return
  // 简化视图：隐藏传递冗余边与全部推断边；原始关系全部保留
  const hidden = state.viewMode === 'simplified' ? redundantIds.value : new Set<string>()

  const connected = new Set<string>()
  for (const r of activeRelations.value) {
    connected.add(r.from)
    connected.add(r.to)
  }

  const nodes = state.units.map((u) => ({
    data: { id: u.id, label: u.label, type: u.type },
    classes: [connected.has(u.id) ? '' : 'isolated', state.selectedUnitId === u.id ? 'selected' : ''].join(' '),
  }))

  // 有效观察（含环冲突）+ 实时推断
  const infIds = new Set(inferredEdges.value.map((e) => e.id))
  const matrix = matrixEdges.value.filter((e) => !hidden.has(e.id))
  const matrixIds = new Set(matrixEdges.value.map((e) => e.id))

  // 尚未生效的原始观察（待复核/否决）：灰点线显示，但不参与布局与偏序
  const nonEffective = activeRelations.value.filter(
    (r) => r.kind === 'earlier' && !matrixIds.has(r.id),
  )

  const contemp = activeRelations.value.filter((r) => r.kind === 'contemporary')

  const edges = [
    ...matrix.map((e) => ({
      data: { id: e.id, source: e.from, target: e.to, stateLabel: '' },
      classes: [
        infIds.has(e.id) ? 'inferred' : '',
        conflictInfo.value.has(e.id) ? 'conflict' : '',
      ].join(' '),
    })),
    ...nonEffective.map((r) => ({
      data: {
        id: r.id,
        source: r.from,
        target: r.to,
        stateLabel: gateState(r) === 'rejected' ? '否决' : '待复核',
      },
      classes: 'noneffective',
    })),
    ...contemp.map((r) => ({
      data: { id: r.id, source: r.from, target: r.to, stateLabel: '同期' },
      classes: 'contemporary',
    })),
  ]

  // 布局只依据无冲突的有效观察边（推断与待复核边不影响分层）
  const auto = layeredPositions(
    state.units.map((u) => u.id),
    orderEdges.value,
  )
  const positionOf = (id: string) => state.positions[id] ?? auto.get(id) ?? { x: 0, y: 0 }

  cy.elements().remove()
  cy.add([...nodes, ...edges])
  cy.layout({ name: 'preset', positions: (n: cytoscape.NodeSingular) => positionOf(n.id()), animate: false }).run()
  cy.fit(undefined, 40)
}

onMounted(() => {
  cy = cytoscape({
    container: el.value!,
    style,
    wheelSensitivity: 0.2,
    boxSelectionEnabled: false,
  })
  cy.on('dragfree', 'node', (e) => {
    const p = e.target.position()
    void savePosition(e.target.id(), p.x, p.y)
  })
  cy.on('tap', 'node', (e) => {
    state.selectedUnitId = state.selectedUnitId === e.target.id() ? null : e.target.id()
  })
  cy.on('tap', (e) => {
    if (e.target === cy) state.selectedUnitId = null
  })
  rebuild()
})

watch(
  () => [
    state.units,
    state.relations,
    state.evidences,
    state.reviews,
    state.viewMode,
    state.layoutVersion,
    state.selectedUnitId,
  ],
  rebuild,
  { deep: true },
)

onBeforeUnmount(() => {
  cy?.destroy()
  cy = null
})
</script>

<template>
  <div class="canvas-wrap">
    <div ref="el" class="canvas"></div>
    <div v-if="state.units.length === 0" class="empty-hint">
      尚无层位。点击「载入示例」查看含证据复核、成环冲突与缺失附件提示的示范工程。
    </div>
    <div class="legend">
      <span><i class="sw deposit"></i>堆积</span>
      <span><i class="sw fill"></i>填充</span>
      <span><i class="sw cut"></i>切割</span>
      <span><i class="sw iface"></i>界面</span>
      <span><i class="ln solid"></i>已采纳观察</span>
      <span><i class="ln dashed"></i>实时推断</span>
      <span><i class="ln gray"></i>待复核/否决</span>
      <span><i class="ln dotted"></i>同期（无向）</span>
      <span><i class="ln red"></i>环冲突</span>
    </div>
  </div>
</template>

<style scoped>
.canvas-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
}
.canvas {
  position: absolute;
  inset: 0;
}
.empty-hint {
  position: absolute;
  top: 40%;
  width: 100%;
  text-align: center;
  color: #888;
  pointer-events: none;
}
.legend {
  position: absolute;
  left: 10px;
  bottom: 10px;
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid #ddd;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: #444;
}
.legend span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.sw {
  width: 12px;
  height: 12px;
  display: inline-block;
  border-radius: 3px;
}
.sw.deposit { background: #8d6e63; }
.sw.fill { background: #ffb300; }
.sw.cut { background: #e53935; transform: rotate(45deg); border-radius: 2px; }
.sw.iface { background: #607d8b; border-radius: 50%; }
.ln {
  width: 18px;
  display: inline-block;
  border-top: 2px solid #2e7d32;
}
.ln.dashed { border-top-color: #ef6c00; border-top-style: dashed; }
.ln.dotted { border-top-color: #7e57c2; border-top-style: dotted; }
.ln.gray { border-top-color: #bdbdbd; border-top-style: dotted; }
.ln.red { border-top-color: #d32f2f; border-top-style: dashed; }
</style>
