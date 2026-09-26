<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import cytoscape from 'cytoscape'
import {
  activeContemporary,
  activeRelations,
  conflictIds,
  evidenceBucket,
  inferredEdges,
  orderEdges,
  redundantIds,
  relationEffective,
  savePosition,
  state,
  unitLabel,
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
      'line-color': '#777',
      'target-arrow-shape': 'triangle',
      'target-arrow-color': '#777',
      'curve-style': 'bezier',
      'arrow-scale': 1.2,
    },
  },
  { selector: 'edge.inferred', style: { 'line-style': 'dashed', 'line-color': '#ef6c00', 'target-arrow-color': '#ef6c00' } },
  { selector: 'edge.inferred-label', style: { label: '推断' } },
  {
    selector: 'edge.pending-label',
    style: { label: '待复核', 'font-size': 10, color: '#b26a00', 'text-rotation': 'autorotate' },
  },
  {
    selector: 'edge.rejected-label',
    style: { label: '已否决', 'font-size': 10, color: '#c62828', 'text-rotation': 'autorotate' },
  },
  {
    selector: 'edge.ineffective',
    style: {
      'line-style': 'dotted',
      'line-color': '#bdbdbd',
      'target-arrow-color': '#bdbdbd',
      opacity: 0.7,
    },
  },
  {
    selector: 'edge.conflict',
    style: {
      'line-color': '#d32f2f',
      'target-arrow-color': '#d32f2f',
      'line-style': 'dashed',
      label: '矛盾',
      'font-size': 10,
      color: '#d32f2f',
      'text-rotation': 'autorotate',
    },
  },
  {
    selector: 'edge.contemporary',
    style: {
      'line-style': 'dotted',
      'line-color': '#7e57c2',
      'target-arrow-shape': 'none',
      label: '同期',
      'font-size': 10,
      color: '#7e57c2',
      'text-rotation': 'autorotate',
    },
  },
]

function rebuild() {
  if (!cy) return
  // 简化视图：仅隐藏有效观察中的传递冗余边；原始关系全部保留在库中
  const hidden = state.viewMode === 'simplified' ? redundantIds.value : new Set<string>()

  const connected = new Set<string>()
  for (const e of orderEdges.value) {
    connected.add(e.from)
    connected.add(e.to)
  }
  for (const r of activeContemporary.value) {
    connected.add(r.from)
    connected.add(r.to)
  }

  const nodes = state.units.map((u) => ({
    data: { id: u.id, label: u.label, type: u.type },
    classes: [connected.has(u.id) ? '' : 'isolated', state.selectedUnitId === u.id ? 'selected' : ''].join(' '),
  }))

  const edges: any[] = []

  // 有效观察边（通过证据闸门且不成环）
  for (const e of orderEdges.value) {
    if (hidden.has(e.id)) continue
    edges.push({ data: { id: e.id, source: e.from, target: e.to }, classes: [] })
  }

  // 推断结论：有效观察偏序的传递闭包，实时重算
  for (const e of inferredEdges.value) {
    edges.push({
      data: { id: e.id, source: e.from, target: e.to },
      classes: ['inferred', 'inferred-label'],
    })
  }

  // 同期关联：同样须通过证据闸门
  for (const r of activeContemporary.value) {
    edges.push({ data: { id: r.id, source: r.from, target: r.to }, classes: ['contemporary'] })
  }

  // 成环冲突：复核决定保留，红边提示但不进入偏序
  for (const r of activeRelations.value) {
    if (r.kind !== 'earlier' || r.source !== 'observation') continue
    if (conflictIds.value.has(r.id)) {
      edges.push({ data: { id: r.id, source: r.from, target: r.to }, classes: ['conflict'] })
    }
  }

  // 未通过证据闸门的“早于”观察（待复核 / 有未解决驳回）：灰色虚线提示存在但不生效
  for (const r of activeRelations.value) {
    if (r.kind !== 'earlier' || r.source !== 'observation') continue
    if (relationEffective(r) || conflictIds.value.has(r.id)) continue
    const b = evidenceBucket(r.id)
    const label = b.accepted.length === 0 ? '待复核' : '已否决'
    edges.push({
      data: { id: `pending:${r.id}`, source: r.from, target: r.to },
      classes: ['ineffective', label === '待复核' ? 'pending-label' : 'rejected-label'],
    })
  }

  // 缺省位置：按分层算法即时计算（不写入库）
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
      尚无层位。点击「载入示例」查看含切割事件、孤立层位与矛盾记录的示范工程。
    </div>
    <div class="legend">
      <span><i class="sw deposit"></i>堆积</span>
      <span><i class="sw fill"></i>填充</span>
      <span><i class="sw cut"></i>切割</span>
      <span><i class="sw iface"></i>界面</span>
      <span><i class="ln solid"></i>有效观察</span>
      <span><i class="ln dashed"></i>推断结论</span>
      <span><i class="ln dotted"></i>同期（无向）</span>
      <span><i class="ln gray"></i>待复核/已否决</span>
      <span><i class="ln red"></i>矛盾</span>
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
  border-top: 2px solid #777;
}
.ln.dashed { border-top-style: dashed; border-top-color: #ef6c00; }
.ln.dotted { border-top-color: #7e57c2; border-top-style: dotted; }
.ln.gray { border-top-color: #bdbdbd; border-top-style: dotted; }
.ln.red { border-top-color: #d32f2f; border-top-style: dashed; }
</style>
