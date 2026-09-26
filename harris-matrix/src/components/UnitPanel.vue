<script setup lang="ts">
import { reactive } from 'vue'
import { addUnit, deleteUnit, state } from '../store'
import type { UnitType } from '../types'

const unitForm = reactive({ label: '', type: 'deposit' as UnitType, note: '' })

const typeNames: Record<UnitType, string> = {
  deposit: '堆积',
  cut: '切割',
  fill: '填充',
  interface: '界面',
  other: '其他',
}

async function submitUnit() {
  await addUnit(unitForm.label, unitForm.type, unitForm.note)
  unitForm.label = ''
  unitForm.note = ''
}

function confirmDelete(id: string, label: string) {
  if (window.confirm(`删除层位 ${label}？涉及它的关系、证据与附件将一并删除（可整体撤销，复核审计保留）。`)) {
    void deleteUnit(id)
  }
}
</script>

<template>
  <section class="panel">
    <h3>层位（{{ state.units.length }}）</h3>
    <form class="form" @submit.prevent="submitUnit">
      <div class="row">
        <input v-model="unitForm.label" placeholder="编号，如 1021" required />
        <select v-model="unitForm.type">
          <option v-for="(name, t) in typeNames" :key="t" :value="t">{{ name }}</option>
        </select>
      </div>
      <input v-model="unitForm.note" placeholder="备注（可选）" />
      <button type="submit">新增层位</button>
    </form>
    <ul class="list">
      <li
        v-for="u in state.units"
        :key="u.id"
        :class="{ selected: state.selectedUnitId === u.id }"
        @click="state.selectedUnitId = state.selectedUnitId === u.id ? null : u.id"
      >
        <span class="badge" :class="u.type">{{ typeNames[u.type] }}</span>
        <span class="grow">
          <b>{{ u.label }}</b>
          <small v-if="u.note">　{{ u.note }}</small>
        </span>
        <button class="danger sm" title="删除层位" @click.stop="confirmDelete(u.id, u.label)">删</button>
      </li>
      <li v-if="state.units.length === 0" class="muted">暂无层位</li>
    </ul>
  </section>
</template>
