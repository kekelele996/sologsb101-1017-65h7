<script setup lang="ts">
/**
 * /export 出炉检验登记与两侧 JSON 存档
 *
 * 出炉检验属于吹制侧（写吹制库）；存档 / 重置按归属拆成吹侧与排侧两套：
 * 任一侧导入或重置都只动自己那本库，另一侧已确认的数据不受影响。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules, type UploadFile } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import StageTag from '@/components/common/StageTag.vue'
import { useAnnealStore } from '@/stores/annealStore'
import { useFurnaceStore } from '@/stores/furnaceStore'
import { usePieceStore } from '@/stores/pieceStore'
import {
  BLOW_DB_NAME,
  BLOW_DB_SCHEMA_VERSION,
  blowDb,
  exportBlowSnapshot,
  importBlowSnapshot,
  resetBlowDatabase,
} from '@/utils/blowDb'
import {
  KILN_DB_NAME,
  KILN_DB_SCHEMA_VERSION,
  exportKilnSnapshot,
  importKilnSnapshot,
  resetKilnDatabase,
} from '@/utils/kilnDb'
import { exportKilnSnapshotJson, exportBlowSnapshotJson, exportScheduleCsvFile, parseSnapshot } from '@/utils/export'
import { useIdbTable } from '@/hooks/useIdbTable'
import { INSPECT_RESULT_OPTIONS, type Inspect, type InspectDraft, type InspectResult } from '@/types/inspect'
import { today } from '@/utils/id'

const router = useRouter()
const pieceStore = usePieceStore()
const annealStore = useAnnealStore()
const furnaceStore = useFurnaceStore()

// 出炉检验归吹制侧
const { rows, loading, create, update, remove } = useIdbTable<Inspect>(blowDb.inspects, { sortByUpdatedAt: false })

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const keyword = ref('')
const resultFilter = ref<InspectResult | 'all'>('all')
const formRef = ref<FormInstance>()

const form = reactive<InspectDraft>({
  pieceId: '',
  result: '合格',
  defectNote: '',
  inspector: '',
  date: today(),
})

const rules = computed<FormRules<InspectDraft>>(() => ({
  pieceId: [{ required: true, message: '请选择作品', trigger: 'change' }],
  result: [{ required: true, message: '请选择检验结果', trigger: 'change' }],
  inspector: [{ required: true, message: '请填写检验人', trigger: 'blur' }],
  date: [{ required: true, message: '请选择检验日期', trigger: 'change' }],
  defectNote:
    form.result === '合格' ? [] : [{ required: true, message: '判定不合格时必须填写缺陷说明', trigger: 'blur' }],
}))

const pieceLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(pieceStore.decoratedPieces.map((row) => [row.id, `${row.name} · ${row.craft}`]))
)

const filtered = computed<Inspect[]>(() => {
  const key = keyword.value.trim().toLowerCase()
  return rows.value
    .filter((row) => {
      if (resultFilter.value !== 'all' && row.result !== resultFilter.value) return false
      if (key === '') return true
      return (
        (pieceLabel.value[row.pieceId] ?? '').toLowerCase().includes(key) ||
        row.inspector.toLowerCase().includes(key) ||
        row.defectNote.toLowerCase().includes(key)
      )
    })
    .sort((a, b) => b.date.localeCompare(a.date))
})

const stats = computed(() => {
  const total = rows.value.length
  const pass = rows.value.filter((row) => row.result === '合格').length
  const defect = total - pass
  return {
    total,
    pass,
    defect,
    passPct: total === 0 ? 0 : Math.round((pass / total) * 1000) / 10,
    inProgress: pieceStore.decoratedPieces.filter((row) => row.state === '设计中' || row.state === '制作中').length,
    occupancyRate: annealStore.occupancyRate,
  }
})

onMounted(() => {
  void pieceStore.loadAll()
  void annealStore.loadAll()
  void furnaceStore.loadAll()
})

function openCreate(): void {
  editingId.value = null
  Object.assign(form, {
    pieceId: pieceStore.currentPieceId ?? pieceStore.pieces[0]?.id ?? '',
    result: '合格' as InspectResult,
    defectNote: '',
    inspector: '',
    date: today(),
  })
  dialogVisible.value = true
}

function openEdit(row: Inspect): void {
  editingId.value = row.id
  Object.assign(form, {
    pieceId: row.pieceId,
    result: row.result,
    defectNote: row.defectNote,
    inspector: row.inspector,
    date: row.date,
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingId.value === null) {
      await create({ ...form }, 'inspect')
      ElMessage.success(
        form.result === '合格'
          ? '检验已登记：合格'
          : `检验已登记：${form.result}，已生成返工提示（原始工序记录保留不变）`,
      )
    } else {
      await update(editingId.value, { ...form })
      ElMessage.success('检验记录已更新')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Inspect): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除 ${row.date} 的检验记录（${row.result}）？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await remove(row.id)
  ElMessage.success('检验记录已删除')
}

async function handleExportBlowJson(): Promise<void> {
  const snapshot = await exportBlowSnapshot()
  const filename = exportBlowSnapshotJson(snapshot)
  ElMessage.success(`已导出吹制侧存档 ${filename}（不含排产侧窑位编排）`)
}

async function handleExportKilnJson(): Promise<void> {
  const snapshot = await exportKilnSnapshot()
  const filename = exportKilnSnapshotJson(snapshot)
  ElMessage.success(`已导出排产侧存档 ${filename}（仅含窑位 / 入窑时间 / 曲线段）`)
}

function handleExportCsv(): void {
  const filename = exportScheduleCsvFile(
    furnaceStore.furnaces,
    furnaceStore.batches,
    pieceStore.pieces,
    pieceStore.steps,
    annealStore.anneals,
    rows.value,
    (pieceId: string) => pieceStore.stateOf(pieceId),
  )
  ElMessage.success(`已导出窑务排产汇总 ${filename}`)
}

async function handleImport(uploadFile: UploadFile): Promise<void> {
  const raw = uploadFile.raw
  if (raw === undefined) return
  const text = await raw.text()
  const result = parseSnapshot(text)
  if (!result.ok || result.snapshot === null || result.side === null) {
    ElMessage.error(result.message)
    return
  }
  if (result.side === 'blow' && 'steps' in result.snapshot) {
    await importBlowSnapshot(result.snapshot)
    await Promise.all([pieceStore.loadAll(), furnaceStore.loadAll()])
  } else if (result.side === 'kiln' && 'anneals' in result.snapshot) {
    await importKilnSnapshot(result.snapshot)
    await annealStore.loadAll()
  }
  ElMessage.success(result.message)
}

function handleResetBlow(): void {
  ElMessageBox.confirm(
    '将清空吹制侧的窑炉、料液、作品、工序与检验并重新灌入演示数据；排产侧窑位编排保持不变。',
    '确认重置吹制侧数据？',
    { type: 'warning', confirmButtonText: '确认重置吹侧', cancelButtonText: '取消' },
  )
    .then(async () => {
      await resetBlowDatabase()
      await Promise.all([pieceStore.loadAll(), furnaceStore.loadAll()])
      ElMessage.success('吹制侧已重置为演示数据（排产侧未受影响）')
    })
    .catch(() => undefined)
}

function handleResetKiln(): void {
  ElMessageBox.confirm(
    '将清空排产侧全部窑位编排并重新灌入演示退火数据；吹制组的作品与工序保持不变。',
    '确认重置排产侧数据？',
    { type: 'warning', confirmButtonText: '确认重置排侧', cancelButtonText: '取消' },
  )
    .then(async () => {
      await resetKilnDatabase()
      await annealStore.loadAll()
      ElMessage.success('排产侧已重置为演示数据（吹制侧未受影响）')
    })
    .catch(() => undefined)
}

const defectRows = computed<Inspect[]>(() => rows.value.filter((row) => row.result !== '合格'))
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="检验记录" :value="stats.total" suffix="条" tone="primary" icon="Histogram" />
      <StatBadge label="合格" :value="stats.pass" suffix="条" tone="success" icon="DataLine" />
      <StatBadge label="不合格" :value="stats.defect" suffix="条" tone="danger" icon="Warning" />
      <StatBadge label="合格率" :value="`${stats.passPct}%`" :percent="stats.passPct" tone="success" icon="PieChart" />
      <StatBadge label="在制件数" :value="stats.inProgress" suffix="件" tone="warning" icon="TrendCharts" />
      <StatBadge
        label="窑位占用率"
        :value="`${stats.occupancyRate}%`"
        :percent="stats.occupancyRate"
        tone="primary"
        icon="PieChart"
      />
      <StatBadge
        label="吹制侧结构版本"
        :value="`v${BLOW_DB_SCHEMA_VERSION}`"
        :suffix="BLOW_DB_NAME"
        tone="info"
        icon="Histogram"
      />
      <StatBadge
        label="排产侧结构版本"
        :value="`v${KILN_DB_SCHEMA_VERSION}`"
        :suffix="KILN_DB_NAME"
        tone="info"
        icon="Sunrise"
      />
    </div>

    <el-alert
      v-if="defectRows.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${defectRows.length} 条检验记录判定不合格，已生成返工提示`"
    >
      <template #default>
        <div class="defect-list">
          <div v-for="row in defectRows" :key="row.id">
            {{ pieceLabel[row.pieceId] ?? '（作品已删除）' }} · {{ row.date }} · {{ row.result }}：
            {{ row.defectNote }} —— 原始工序记录保留，可在工序页重新推进状态后再次入窑退火。
          </div>
        </div>
      </template>
    </el-alert>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">出炉检验登记与两侧存档</span>
          <el-space wrap>
            <el-button @click="handleExportBlowJson">
              <el-icon><Download /></el-icon>
              <span>导出吹侧存档</span>
            </el-button>
            <el-button @click="handleExportKilnJson">
              <el-icon><Download /></el-icon>
              <span>导出排侧存档</span>
            </el-button>
            <el-button @click="handleExportCsv">
              <el-icon><Download /></el-icon>
              <span>导出 CSV 汇总</span>
            </el-button>
            <el-upload :auto-upload="false" :show-file-list="false" accept=".json" :on-change="handleImport">
              <el-button>
                <el-icon><Upload /></el-icon>
                <span>导入存档（自动识别归属侧）</span>
              </el-button>
            </el-upload>
            <el-button type="warning" plain @click="handleResetKiln">重置排侧演示数据</el-button>
            <el-button type="danger" plain @click="handleResetBlow">重置吹侧演示数据</el-button>
            <el-button type="primary" @click="openCreate" :disabled="pieceStore.pieces.length === 0">
              <el-icon><Plus /></el-icon>
              <span>登记检验</span>
            </el-button>
          </el-space>
        </div>
      </template>

      <FilterBar
        :keyword="keyword"
        :fields="[{ key: 'result', label: '检验结果', options: INSPECT_RESULT_OPTIONS as unknown as string[] }]"
        :values="{ result: resultFilter }"
        :result-text="`命中 ${filtered.length} / ${rows.length} 条`"
        @update:keyword="(value: string) => (keyword = value)"
        @change="(key: string, value: string) => { if (key === 'result') resultFilter = value as InspectResult | 'all' }"
        @reset="
          () => {
            keyword = ''
            resultFilter = 'all'
          }
        "
      />

      <EmptyPanel
        v-if="rows.length === 0 && !loading"
        title="还没有出炉检验记录"
        description="作品退火出炉后登记检验结果；判定为裂纹 / 气泡 / 变形时会生成返工提示，同时保留原始工序记录用于追溯。"
        action-text="登记第一条检验"
        @action="openCreate"
      />

      <el-table v-else v-loading="loading || !pieceStore.ready" :data="filtered" row-key="id" stripe>
        <el-table-column label="作品" min-width="190">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-link type="primary" @click="router.push(`/pieces/${row.pieceId}/steps`)">
                {{ pieceLabel[row.pieceId] ?? '（作品已删除）' }}
              </el-link>
              <StageTag :stage="pieceStore.stateOf(row.pieceId)" size="small" />
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="date" label="检验日期" width="120" />
        <el-table-column label="检验结果" width="120">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.result === '合格' ? 'success' : row.result === '裂纹' ? 'danger' : row.result === '气泡' ? 'warning' : 'info'"
              effect="dark"
            >
              {{ row.result }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="缺陷说明 / 返工提示" min-width="300">
          <template #default="{ row }">
            <span v-if="row.defectNote === ''" class="cell-sub">无缺陷</span>
            <span v-else :class="{ 'cell-warn': row.result !== '合格' }">{{ row.defectNote }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="inspector" label="检验人" width="110" />
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '登记出炉检验' : '编辑出炉检验'" width="620px">
      <el-form ref={formRef} :model="form" :rules="rules" label-width="120px">
        <el-form-item label="作品" prop="pieceId">
          <el-select v-model="form.pieceId" filterable style="width: 100%">
            <el-option
              v-for="item in pieceStore.decoratedPieces"
              :key="item.id"
              :value="item.id"
              :label="`${item.name} · ${item.craft} · ${item.state}`"
            />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="检验结果" prop="result">
              <el-select v-model="form.result" style="width: 100%">
                <el-option v-for="item in INSPECT_RESULT_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="检验人" prop="inspector">
              <el-input v-model="form.inspector" placeholder="如：吴岚" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="检验日期" prop="date">
              <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="缺陷说明" prop="defectNote">
          <el-input
            v-model="form.defectNote"
            type="textarea"
            :rows="2"
            :placeholder="form.result === '合格' ? '可选：填写检验备注' : '必填：描述缺陷位置与程度，并给出返工建议'"
          />
        </el-form-item>
        <el-alert
          v-if="form.result !== '合格'"
          type="warning"
          show-icon
          :closable="false"
          title="判定为「裂纹 / 气泡 / 变形」将生成返工提示"
          description="原始吹制工序记录会完整保留，返工后可在工序页重新推进状态并再次入窑退火。"
        />
        <el-alert
          v-else
          type="success"
          show-icon
          :closable="false"
          title="合格归档"
          description="检验登记后作品全流程状态由两侧数据自动派生为「已检验」，不会覆盖排产侧任何数据。"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #1d2b3a;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cell-sub {
  font-size: 12px;
  color: #8b95a1;
}

.cell-warn {
  color: #c0392b;
}

.defect-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 1.8;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
