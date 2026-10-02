# 玻璃吹制工序与退火窑编排台（sologsb101-1017）

面向玻璃工作室，**吹制组**与**窑务排产员**两侧协作：吹制组逐道记录每件作品的取料、
吹制、塑形、开模、收口工序（温度 / 时长 / 操作人）；窑务排产员分配退火窑位、入窑时间
与温度曲线，出炉检验并归档。

**两侧各持一本本地库（IndexedDB），互不覆盖**：

| 归属 | 库名 | 可写内容 |
| --- | --- | --- |
| 吹制组 | `gbglassblow-blow` | 窑炉 / 料液批次 / 作品 / **工序道次、温度、时长、操作人** / 出炉检验 |
| 窑务排产员 | `gbglassblow-kiln` | **窑位、入窑时间、曲线段**、出炉时间、退火状态 |

任一侧对另一侧的库只有只读订阅；作品全流程状态（制作中 / 已退火 / 已检验）由两侧数据
在读取层即时派生，不再跨表回写。任一侧保存失败只按本侧重试（最多 3 次指数退避），
另一方已确认的数据不受影响。首次打开 v3 会把旧的单库 `gbglassblow` 数据**按归属一次性
迁移**到两本库（旧库保留作回滚兜底）。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22817**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbglassblow` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3 | `<script setup>` 组合式 API |
| 语言 | TypeScript 5 | `strict` 模式，`vue-tsc --noEmit` 零错误 |
| UI 组件库 | Element Plus 2 | 表格、表单、弹窗、日期时间选择、进度条、消息提示 |
| 图标 | @element-plus/icons-vue | 入口统一全局注册 |
| 构建 | Vite 6 | 开发端口与宿主端口一致（22817） |
| 路由 | Vue Router 4 | `createWebHistory` + 路由懒加载 |
| 状态管理 | Pinia 2 | setup store，跨页状态集中在 store，页面只读 store |
| 本地持久化 | Dexie 4（IndexedDB） | **双库拆分**：吹制库 `gbglassblow-blow` v1 + 排产库 `gbglassblow-kiln` v1；v3 首次打开时把旧库 `gbglassblow` v2 按归属迁移到两库 |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1017/
├── README.md
├── docker-compose.yml          # name: gbglassblow，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 入口：Pinia + Router + Element Plus + 初始化数据库
        ├── App.vue             # 外壳：顶部导航 + 当前作品上下文 + 页脚
        ├── env.d.ts
        ├── styles/main.css
        ├── types/              # furnace.ts batch.ts piece.ts step.ts anneal.ts inspect.ts
        ├── stores/             # furnaceStore.ts pieceStore.ts annealStore.ts
        ├── components/common/  # StageTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useStepProgress.ts useIdbTable.ts
        ├── pages/              # 5 个模块页面
        ├── router/index.ts     # 路由表 + ROUTES 常量
        └── utils/              # blowDb.ts kilnDb.ts ownership.ts derivedState.ts
                               # seedBlow.ts seedKiln.ts thermal.ts export.ts id.ts
        # smoke.ts / smoke-migration.ts：Node + fake-indexeddb 冒烟测试（不进 Docker 镜像）
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/furnaces` | `pages/FurnaceList.vue` | 窑炉与料液台账：新建/编辑/级联删除窑炉、登记料液批次、取料按剩余量扣减、低于阈值高亮提示补料 |
| `/pieces` | `pages/PieceList.vue` | 作品登记与设计尺寸录入：按工艺与状态筛选、设计尺寸比例校验、显示工序完成度与当前道次 |
| `/pieces/:id/steps` | `pages/StepDetail.vue` | 吹制工序逐道记录：拖拽排序、回填温度/时长/操作人、推进工序状态、前序未完成阻断进入退火排位 |
| `/annealing` | `pages/AnnealingBoard.vue` | 退火窑位分配与曲线编排：窑位占用表、**窑位冲突时禁用提交**、状态流转、出炉回写作品状态 |
| `/export` | `pages/ExportView.vue` | 出炉检验登记（不合格生成返工提示）+ JSON 结构版本查看与导入导出 + 窑务 CSV 汇总 |

`/` 重定向到 `/furnaces`，未匹配路径统一回落到 `/furnaces`。
**层级路由支持直接深链**：把 `http://localhost:22817/pieces/piece-morning-vase/steps` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「作品不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明（双库归属）

* **持久化方案**：IndexedDB，通过 Dexie 封装。两个库物理分离，从根上消除「后保存的一方
  用旧整行覆盖对方字段」的问题——两侧写入的表没有任何交集。
* **吹制库 `gbglassblow-blow`（结构 v1）**：

  | 表 | 主键 | 主要索引 | 写归属 |
  | --- | --- | --- | --- |
  | `furnaces` | id | code, type, state, fuelType, createdAt, updatedAt | 吹制组（窑务台账） |
  | `batches` | id | furnaceId, colorCode, meltDate, remainKg | 吹制组 |
  | `pieces` | id | batchId, state, artist, craft, name | 吹制组 |
  | `steps` | id | pieceId, **[pieceId+seq]**, seq, state, name | **吹制组：工序道次 / 温度 / 时长 / 操作人** |
  | `inspects` | id | pieceId, date, result, inspector | 吹制组（出炉检验） |

* **排产库 `gbglassblow-kiln`（结构 v1）**：

  | 表 | 主键 | 主要索引 | 写归属 |
  | --- | --- | --- | --- |
  | `anneals` | id | pieceId, kilnSlot, state, inAt, curveSeg | **窑务排产员：窑位 / 入窑时间 / 曲线段** |

* **跨库只读**：排产侧用独立的只读 Dexie 连接订阅吹侧的 `pieces / steps / furnaces`
  （壁厚决定退火时长、工序完成度决定能否排位、退火窑台账决定窑位池）；吹侧同样只读订阅
  排侧 `anneals`。只读数据变化通过 `liveQuery` 自动刷新，无需轮询。
* **作品状态派生（`src/utils/derivedState.ts`）**：有检验记录 → 已检验；有已出炉退火 →
  已退火；有工序 → 制作中；否则设计中。两侧都不再回写对方表，改窑位 / 重排工序互不冲数据。
* **前序卡点（排产员视角）**：退火页顶部「前序卡点」面板列出所有工序未做完的作品，明确
  显示「卡在第 N 道『工序名』（当前状态）」，包含已提前占了「待入窑」位但工序未完成的件
  （需催办或推迟入窑时间）；新建排位时前序未完成的作品在下拉中禁选并禁止提交。
* **本侧重试（`src/utils/ownership.ts`）**：所有写库操作经 `withSideRetry` 包裹，瞬时错误
  （事务中断 / 配额 / I/O）最多重试 3 次并指数退避；`DataCloneError` 等确定性错误不重试。
  失败信息明确提示「另一侧数据不受影响」，用户在本侧重试即可。
* **旧库迁移**：v3 首次打开时（localStorage 幂等标记），把旧库 `gbglassblow` 的
  furnaces / batches / pieces / steps / inspects 复制到吹制库、anneals 复制到排产库；
  旧库不删除作为回滚兜底；两本新库为空时才各自播种演示数据。
* **首屏演示数据**：吹侧 3 台窑炉、4 批料液（A-207 余 42 kg 低于补料阈值）、5 件作品、
  17 道工序、3 条检验；排侧 4 条退火（A1/A2/A3/B1 互不冲突）。晨雾花器工序未做完仍占位
  待入窑，用于演示前序卡点。固定 id 如 `piece-morning-vase` 可直接深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的作品 id」与旧库迁移完成标记。
* 删除窑炉级联清理其料液批次（吹侧事务）；删除作品只清吹侧的工序与检验，**排产侧的窑位
  编排不会被连带删除**（页面显示「（作品已删除）」占位），归属边界清晰。
* **存档**：吹侧 / 排侧分别导出、导入 JSON 存档，导入按文件内 `name` 自动识别归属侧，
  只覆盖本侧数据；旧版整库存档会被识别并提示走自动迁移。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22817
```

其他命令：

```bash
npm run build        # vue-tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run test:smoke   # Node + fake-indexeddb 冒烟：双库播种/跨库派生/卡点/冲突/重试/旧库迁移
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则（`src/utils/thermal.ts`）

* **退火曲线时长换算**
  * 升温：20 ℃ → 560 ℃，按 120 ℃/h；
  * 保温：560 ℃ 恒温，每 5 mm 壁厚保温 1.2 小时（壁厚越大保温越久）；
  * 缓冷：560 ℃ → 60 ℃，按 40 ℃/h。
  三段合计即该作品的**理论退火时长**，壁厚直接决定总时长。
* **窑位占用判重**：同一窑位的时间窗 `[入窑, 出炉]` 重叠即判定冲突；未出炉时以「入窑 + 该曲线段理论时长」作为临时出炉时间参与判重。
  **冲突时提交按钮禁用**并给出冲突的既有记录说明。
* **温度单位换算**：℃ ↔ ℉（`cToF` / `fToC`）。
* **工序温度校验**：不得超过所选窑炉的 `maxTempC`，且应落在工艺适宜区间（吹制 900–1200 ℃ / 铸造 800–1150 ℃ / 热塑 700–1000 ℃）附近。
* **设计尺寸校验**：壁厚需 ≥ 1.5 mm 且小于设计高度的 1/8，否则给出成型与退火难度提示。
* **前序阻断**：任一前序工序未推进到「已完成」，`/pieces/:id/steps` 与退火排位都会给出
  明确阻断原因；排产页把这类件归入「前序卡点」面板，排产员直接看到卡在哪一件的哪一道。
* **状态派生（不跨侧回写）**：退火推进到「已出炉」、登记出炉检验后，作品状态由两侧
  数据读取层即时派生为「已退火 / 已检验」；判定不合格生成返工提示，**原始工序记录完整保留**。
* **料液扣减**：取料按剩余量扣减（不足时扣到 0），剩余量低于 60 kg 时列表行高亮并在顶部汇总提醒。
