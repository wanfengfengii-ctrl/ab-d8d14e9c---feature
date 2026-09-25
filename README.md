# 海洋微塑料监测站 · 显微视野拼接去重裁决服务

海洋微塑料监测站在拼接同一滤膜的相邻显微视野计数时，重叠带内的同一颗粒容易被重复计数。
本服务让分析员在网页录入 **3–5 个视野** 的已知平移位置及每个视野中的颗粒候选（唯一编号、整数坐标、聚合物类别），
发起去重裁决后，前端调用真实接口 `POST /api/particle-deduplications`，
展示每个最终颗粒包含的观测、代表坐标、类别以及最终颗粒总数。

裁决成功后，分析员可在结果旁创建 **复测证据单**：服务端以当时完整草稿 **重新裁决并冻结**
最终颗粒、采用关联及来源摘要（含哈希），避免后续编辑把人工复核归到另一套结论。
复核员对每条采用关联逐条记录“确认 / 否决”：全部确认才标记为 **已证实**，任一否决立即转为 **需重裁决**，
页面持续显示冻结来源、剩余项、进度与首条否决关联。证据单落盘持久化，服务重启后按编号恢复。

项目零第三方运行时依赖（Node.js 标准库），从空仓库交付 `Dockerfile` 与 `docker-compose.yml`，
宿主机端口可配置、应用带健康检查，并含名为 **verify** 的一次性服务：
自动执行构建检查、单元测试、API 冒烟验收与证据单重启恢复验收后以退出码结束。

---

## 快速开始（Docker）

```bash
# 启动应用（默认宿主机端口 8080）
docker compose up --build app

# 宿主机端口可配置
APP_PORT=9000 docker compose up --build app

# 一次性验收：构建检查 + 单元测试 + API 冒烟，以退出码结束
docker compose up --build --exit-code-from verify verify
# 或
docker compose run --rm verify
```

启动后访问 `http://localhost:${APP_PORT:-8080}` 使用录入界面。

- 应用容器内端口固定为 `8080`（可用环境变量 `PORT` 覆盖，需同步调整映射）；
- 健康检查：`GET /api/health`（Dockerfile 内置 `HEALTHCHECK`，Compose 继承）；
- 证据单数据目录：容器内 `DATA_DIR=/app/data`（Compose 挂载命名卷 `evidence-data`，容器重启 / 重建后证据单按编号恢复）；
- `verify` 为一次性服务：构建检查（`node --check`）→ 单元测试（`node --test`）→
  在容器内启动真实服务执行 API 冒烟验收（含证据单业务 API）→ 证据单重启恢复验收，
  全部通过以退出码 `0` 结束，否则为 `1`。

## 本地开发（Node.js ≥ 20，无需安装依赖）

```bash
npm start        # 启动服务（PORT 环境变量可改端口，默认 8080）
npm test         # 单元测试 + 随机化暴力对拍
npm run verify   # 一次性验收（构建检查 + 测试 + API 冒烟）
BASE_URL=http://127.0.0.1:8080 npm run smoke   # 对已运行服务做 API 冒烟
```

---

## 裁决规则（形式化）

1. **候选关联**：仅当两条观测来自 *不同视野*、*聚合物类别相同*，且换算到滤膜坐标后
   *横向差与纵向差均不超过容差* 时，二者之间才存在候选关联。
   滤膜坐标 = 视野平移位置 + 视野内坐标。
2. **合法方案**：所选关联构成森林；每个最终颗粒（连通分量）中的观测通过所选关联连通，
   且同一视野至多一个观测。冗余（成环）关联不减少颗粒数、不降低总差，不作为方案的一部分。
3. **三目标全序**（精确全局最优，拒绝“局部最近边贪心合并”）：
   1. 最少化最终颗粒数（等价于最多化所选关联数）；
   2. 最小化所选关联的曼哈顿差总和（曼哈顿差 = 滤膜坐标横向差 + 纵向差）；
   3. 仍相同者，按 **字典序** 确定唯一结论：观测按“视野录入顺序 → 视野内录入顺序”展开，
      每个观测贡献其 *直接关联伙伴编号* 的升序列表（编号按字符串序比较）；
      逐观测比较伙伴列表（列表按字典序、公共前缀较短者更小），首个差异决定胜负。
4. **代表坐标**：最终颗粒全部成员滤膜坐标的质心，四舍五入保留两位小数。
5. **输出顺序**：最终颗粒按其最早观测的全局顺序编号（#1、#2、…）。

### 求解方法

候选图按连通分量分解后逐分量精确求解：第一阶段以迭代式分支定界求
`(最多关联数, 最小总差)`；第二阶段在达到该最优值的全部森林中，
通过“逐观测确定伙伴列表 + 可行性判定（强制包含/排除）”构造字典序最小方案。
正确性由 `test/bruteforce.test.js` 中数百个随机用例与全子集枚举的暴力实现对拍保证。

规模保护（超出返回 `422`）：候选关联总数 ≤ 100000；单个重叠区域观测 ≤ 200、候选关联 ≤ 5000。

---

## API 契约

### `POST /api/particle-deduplications`

**请求体**

```json
{
  "tolerance": 5,
  "fields": [
    {
      "name": "F1",
      "offset": { "x": 0, "y": 0 },
      "particles": [
        { "id": "A1", "x": 10, "y": 10, "category": "PE" }
      ]
    }
  ]
}
```

| 字段 | 规则 |
| --- | --- |
| `tolerance` | 必填，0 ~ 1000000 的整数 |
| `fields` | 必填，3 ~ 5 个视野 |
| `fields[i].name` | 可选，≤ 50 字符，缺省为 `F{i+1}` |
| `fields[i].offset.x/y` | 必填整数，|v| ≤ 1000000 |
| `fields[i].particles` | 必填数组，每视野 ≤ 500、合计 ≤ 2000 |
| `particles[j].id` | 非空字符串（≤ 64 字符），**全部视野内唯一** |
| `particles[j].x/y` | 必填整数，|v| ≤ 1000000 |
| `particles[j].category` | 非空字符串（≤ 50 字符） |

**成功响应 `200`**（节选）

```json
{
  "tolerance": 5,
  "fieldCount": 3,
  "observationCount": 7,
  "linkCount": 2,
  "totalParticles": 5,
  "particles": [
    {
      "id": 2,
      "category": "PP",
      "representative": { "x": 40, "y": 41 },
      "observations": [
        { "fieldIndex": 0, "fieldName": "F1", "particleId": "A2",
          "localX": 40, "localY": 40, "filterX": 40, "filterY": 40 },
        { "fieldIndex": 2, "fieldName": "F3", "particleId": "C1",
          "localX": 40, "localY": -58, "filterX": 40, "filterY": 42 }
      ],
      "links": [{ "a": "A2", "b": "C1", "manhattan": 2 }]
    }
  ]
}
```

**输入不合规 `400`**：返回全部可定位问题，前端据此高亮对应录入项并保留草稿。

```json
{
  "error": {
    "message": "输入不合规，请根据定位信息修正后重新提交（草稿已保留）",
    "issues": [
      { "path": "tolerance", "message": "容差必须是 0 ~ 1000000 的整数" },
      { "path": "fields[1].particles[0].id", "message": "颗粒编号“A1”重复（首次出现于 fields[0].particles[0].id）" },
      { "path": "fields[1].particles[0].x", "message": "颗粒坐标必须是 |v| ≤ 1000000 的整数" }
    ]
  }
}
```

其他状态码：`413` 请求体过大；`422` 超出求解规模上限；`404` 接口/资源不存在。

### `GET /api/health`

返回 `200 {"status":"ok","service":"particle-deduplication"}`，用于容器健康检查。

---

## 复测证据单

裁决成功后，分析员以当时完整草稿创建证据单；服务端 **重新裁决** 并冻结最终颗粒、采用关联与来源摘要
（视野 / 观测计数 + 草稿内容 SHA-256 哈希），之后对草稿的任何修改都不会改写既有证据单。

**状态机**（由关联判定派生）：

| 状态 | 含义 |
| --- | --- |
| `pending` | 复核中：尚有采用关联未获判定 |
| `verified` | 已证实：全部采用关联均获确认（零关联裁决创建即为已证实） |
| `needs_readjudication` | 需重裁决：任一关联被否决立即生效，`firstRejectedLinkId` 指向首条否决关联 |

终态（`verified` / `needs_readjudication`）后不再接受复核提交（`409 SHEET_CLOSED`）；
需重裁决时应修正草稿、重新裁决并创建新证据单。

**幂等与并发**：每次复核提交携带当前 `version` 与唯一 `operationId`——

- 同操作号同内容重试 → `200` 返回首次提交的原结果（`idempotentReplay: true`），证据单不变；
- 同操作号不同内容 → `409 OPERATION_CONFLICT`，证据单不变；
- 过期版本 → `409 STALE_VERSION`（响应含 `currentVersion`），证据单不变；
- 重复判定已决关联 → `409 LINK_ALREADY_DECIDED`；未知关联 → `400 UNKNOWN_LINK`。

**持久化**：每份证据单一个 JSON 文件（原子写入）存于 `DATA_DIR`（本地默认 `./data`，容器内 `/app/data`），
创建与每次提交后落盘，服务重启后按编号恢复（含复核进度、冻结结论与幂等日志）。

### `POST /api/review-evidence-sheets`

请求体与去重裁决相同（当时完整草稿 `{tolerance, fields}`）。校验失败 `400`（可定位 issues）、
超规模 `422`；成功 `201` 返回证据单完整视图：

```json
{
  "id": 1,
  "version": 0,
  "status": "pending",
  "source": {
    "tolerance": 1, "fieldCount": 3, "observationCount": 5,
    "fields": [{ "name": "F1", "offset": { "x": 0, "y": 0 }, "particleCount": 2 }],
    "hash": "ce632029…", "draft": { "tolerance": 1, "fields": [] }
  },
  "result": { "totalParticles": 3, "linkCount": 2, "particles": [] },
  "links": [
    {
      "linkId": 1, "particleId": 1, "category": "PE",
      "a": { "fieldName": "F1", "particleId": "A1", "localX": 0, "localY": 0, "filterX": 0, "filterY": 0 },
      "b": { "fieldName": "F2", "particleId": "B2", "localX": 0, "localY": 1, "filterX": 0, "filterY": 1 },
      "dx": 0, "dy": 1, "manhattan": 1,
      "decision": null, "decidedAt": null
    }
  ],
  "progress": { "total": 2, "confirmed": 0, "rejected": 0, "remaining": 2 },
  "firstRejectedLinkId": null
}
```

### `GET /api/review-evidence-sheets` / `GET /api/review-evidence-sheets/:id`

列表（摘要）与按编号获取完整视图；不存在返回 `404`。

### `POST /api/review-evidence-sheets/:id/reviews`

```json
{ "version": 0, "operationId": "review-2026-0001", "decisions": [{ "linkId": 1, "decision": "confirm" }] }
```

- `decision` 取值 `"confirm"`（确认）/ `"reject"`（否决）；单次可提交 1–500 条判定；
- 成功 `200` 返回更新后的完整视图（`idempotentReplay: false`）；冲突与校验失败见上表。

---

## 前端使用

- 录入 3–5 个视野（可增删），每个视野填写名称（可选）、平移 X/Y 与颗粒表（编号、X、Y、类别，类别带常用聚合物候选）；
- 草稿实时保存在浏览器 `localStorage`，刷新或校验失败均不丢失；
- 点击 **发起去重裁决** 调用 `POST /api/particle-deduplications`：
  - 成功：展示最终颗粒总数，以及每个颗粒的类别、代表坐标、观测明细（视野 / 编号 / 局部坐标 / 滤膜坐标）与所选关联（含曼哈顿差）；
  - 失败：列出全部可定位问题（`fields[1].particles[0].x` 形式）并高亮对应输入框，草稿保留；
- **载入示例** 可一键填充演示数据；
- 裁决结果旁点击 **创建复测证据单**：服务端以本次裁决的完整草稿重新裁决并冻结，页面出现证据单面板——
  持续显示冻结来源（容差 / 视野 / 观测数 / 来源哈希）、进度条与剩余待复核条数；
  复核员对每条采用关联（两端观测、类别、坐标差）逐条点击 **确认 / 否决**，
  任一否决立即置为“需重裁决”并高亮首条否决关联（即阻止本次颗粒计数被证实的那条显微关联）；
  网络失败可按原操作号重试（不会重复判定），页面刷新后自动恢复最近一份证据单。

## 项目结构

```
├── Dockerfile              # 应用镜像（含 HEALTHCHECK，零依赖，非 root 运行，/app/data 证据单目录）
├── docker-compose.yml      # app（端口可配置 + evidence-data 命名卷）+ verify（一次性验收）
├── package.json            # 无第三方依赖
├── src/
│   ├── server.js           # HTTP 服务：API 路由、静态资源、健康检查
│   ├── validation.js       # 输入校验（可定位 issues）
│   ├── dedup.js            # 精确求解器（分支定界 + 字典序构造）
│   └── evidence.js         # 复测证据单：冻结结论、复核状态机、幂等、落盘恢复
├── public/                 # 录入、结果展示与证据单复核前端（原生 HTML/JS/CSS）
├── test/                   # 单元测试 + 随机化暴力对拍 + 证据单（含重启恢复）测试
└── scripts/
    ├── verify.js           # 一次性验收：构建检查 → 测试 → API 冒烟 → 证据单重启恢复 → 退出码
    └── smoke.js            # API 冒烟验收（含证据单业务 API，可独立对运行中的服务执行）
```
