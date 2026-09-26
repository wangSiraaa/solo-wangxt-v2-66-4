<script setup lang="ts">
import { computed, reactive } from 'vue'
import {
  activeRelations,
  addRelation,
  conflictInfo,
  gateState,
  inferredEdges,
  retractRelation,
  state,
  unitLabel,
} from '../store'
import type { Relation, RelationKind } from '../types'
import EvidenceReview from './EvidenceReview.vue'

const form = reactive({
  from: '',
  to: '',
  kind: 'earlier' as RelationKind,
  note: '',
})

const expanded = reactive(new Set<string>())

function toggle(id: string) {
  if (expanded.has(id)) expanded.delete(id)
  else expanded.add(id)
}

const observations = computed(() =>
  activeRelations.value
    .filter((r) => r.source === 'observation' && r.kind === 'earlier')
    .sort((a, b) => a.createdAt - b.createdAt),
)

const contemporaries = computed(() => activeRelations.value.filter((r) => r.kind === 'contemporary'))

/** 旧版手填推断：仅存档灰显，不参与实时偏序与推断重算 */
const legacyInferences = computed(() =>
  activeRelations.value.filter((r) => r.source === 'inference' && r.kind === 'earlier'),
)

const conflicts = computed(() =>
  observations.value
    .filter((r) => conflictInfo.value.has(r.id))
    .map((r) => ({ r, path: conflictInfo.value.get(r.id)! })),
)

const gateNames = { valid: '已生效', pending: '待复核', rejected: '未解决否决' } as const

function describe(r: Relation): string {
  return r.kind === 'earlier'
    ? `${unitLabel(r.from)} 早于 ${unitLabel(r.to)}`
    : `${unitLabel(r.from)} ≈ ${unitLabel(r.to)}（同期）`
}

async function submit() {
  await addRelation({ ...form, source: 'observation', evidenceIds: [] })
  form.note = ''
}

function retract(r: Relation) {
  const reason = window.prompt(`撤回「${describe(r)}」的理由：`)
  if (reason !== null) void retractRelation(r.id, reason)
}
</script>

<template>
  <section class="panel">
    <h3>登记原始观察</h3>
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
      <input v-model="form.note" placeholder="备注（可选）" />
      <button type="submit">登记观察（随后添加证据并复核）</button>
      <p class="hint">
        只有至少一条已采纳证据、且没有未解决否决的观察才进入有效偏序；采纳会成环时保留复核决定并标记冲突。
      </p>
    </form>
  </section>

  <section v-if="conflicts.length" class="panel conflict-panel">
    <h3>环冲突（{{ conflicts.length }}，记录均保留）</h3>
    <ul class="list">
      <li v-for="{ r, path } in conflicts" :key="r.id" class="conflict-row">
        <span class="grow">
          <b>{{ describe(r) }}</b>
          <div class="cycle">{{ path.map(unitLabel).join(' → ') }}</div>
        </span>
      </li>
    </ul>
  </section>

  <section class="panel">
    <h3>
      原始观察（{{ observations.length }}）·
      生效 {{ observations.filter((r) => gateState(r) === 'valid').length }}
    </h3>
    <ul class="list">
      <li v-for="r in observations" :key="r.id" class="rel-row" :class="[gateState(r), { conflict: conflictInfo.has(r.id) }]">
        <span class="grow" @click="toggle(r.id)">
          {{ describe(r) }}
          <span class="tag" :class="gateState(r)">{{ gateNames[gateState(r)] }}</span>
          <span v-if="conflictInfo.has(r.id)" class="tag conflict">环冲突</span>
          <br />
          <small class="muted">
            {{ expanded.has(r.id) ? '▼' : '▶' }} 证据与复核
            <template v-if="r.note">　{{ r.note }}</template>
          </small>
        </span>
        <button class="sm" title="撤回该判断" @click="retract(r)">撤回</button>
        <EvidenceReview v-if="expanded.has(r.id)" :relation="r" class="full" />
      </li>
      <li v-if="observations.length === 0" class="muted">暂无原始观察</li>
    </ul>
  </section>

  <section class="panel">
    <h3>推断关系（实时导出，{{ inferredEdges.length }}）</h3>
    <ul class="list">
      <li v-for="e in inferredEdges" :key="e.id" class="inferred-row">
        <span class="grow">
          {{ unitLabel(e.from) }} 早于 {{ unitLabel(e.to) }}
          <span class="tag inference">推断</span>
        </span>
      </li>
      <li v-if="inferredEdges.length === 0" class="muted">尚无传递推断（采纳更多观察后自动出现）</li>
    </ul>
  </section>

  <section v-if="contemporaries.length" class="panel">
    <h3>同期关联（{{ contemporaries.length }}，不进入有向图）</h3>
    <ul class="list">
      <li v-for="r in contemporaries" :key="r.id" class="rel-row" :class="gateState(r)">
        <span class="grow" @click="toggle(r.id)">
          {{ describe(r) }}
          <span class="tag contemp">无向</span>
          <span class="tag" :class="gateState(r)">{{ gateNames[gateState(r)] }}</span>
          <br />
          <small class="muted">{{ expanded.has(r.id) ? '▼' : '▶' }} 证据与复核</small>
        </span>
        <button class="sm" title="撤回该判断" @click="retract(r)">撤回</button>
        <EvidenceReview v-if="expanded.has(r.id)" :relation="r" class="full" />
      </li>
    </ul>
  </section>

  <section v-if="legacyInferences.length" class="panel">
    <h3>旧版手填推断存档（{{ legacyInferences.length }}，不参与计算）</h3>
    <ul class="list">
      <li v-for="r in legacyInferences" :key="r.id" class="legacy-row">
        <span class="grow">
          <s>{{ describe(r) }}</s>
          <span class="tag inference">存档</span>
          <small v-if="r.note" class="muted">　{{ r.note }}</small>
        </span>
      </li>
    </ul>
  </section>

  <section class="panel">
    <h3>已撤回判断（{{ state.retractions.length }}）</h3>
    <ul class="list">
      <li v-for="x in state.retractions" :key="x.id" class="retracted">
        <span class="grow">
          <s>{{ describe(x.snapshot) }}</s>
          <span class="tag" :class="x.snapshot.source">{{ x.snapshot.source === 'observation' ? '观察' : '推断' }}</span>
          <br />
          <small class="muted">{{ new Date(x.at).toLocaleString('zh-CN', { hour12: false }) }}　理由：{{ x.reason }}</small>
        </span>
      </li>
      <li v-if="state.retractions.length === 0" class="muted">暂无</li>
    </ul>
  </section>
</template>

<style scoped>
.rel-row {
  flex-wrap: wrap;
  align-items: flex-start;
}
.rel-row :deep(.full) {
  flex-basis: 100%;
}
.rel-row.valid {
  border-left: 3px solid #2e7d32;
}
.rel-row.pending {
  border-left: 3px solid #f9a825;
  opacity: 0.85;
}
.rel-row.rejected {
  border-left: 3px solid #c62828;
}
.rel-row.conflict {
  background: #fdecea;
}
.inferred-row {
  opacity: 0.8;
}
.legacy-row {
  opacity: 0.55;
}
.retracted {
  background: #faf3f3;
}
.tag.valid {
  border-color: #2e7d32;
  color: #2e7d32;
}
.tag.pending {
  border-color: #f9a825;
  color: #f9a825;
}
.tag.rejected {
  border-color: #c62828;
  color: #c62828;
}
.conflict-panel {
  border-color: #c62828;
}
.conflict-row {
  background: #fdecea;
}
.cycle {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  color: #c62828;
  margin-top: 2px;
  word-break: break-all;
}
.hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: #888;
}
</style>
