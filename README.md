# 海洋微塑料监测站 · 显微视野拼接去重裁决服务

海洋微塑料监测站在拼接同一滤膜的相邻显微视野计数时，重叠带内的同一颗粒容易被重复计数。
本服务让分析员在网页录入 **3–5 个视野** 的已知平移位置及每个视野中的颗粒候选（唯一编号、整数坐标、聚合物类别），
发起去重裁决后，前端调用真实接口 `POST /api/particle-deduplications`，
展示每个最终颗粒包含的观测、代表坐标、类别以及最终颗粒总数。

裁决成功后，分析员可在结果旁创建 **复测证据单**：服务端以当时完整草稿重新裁决并冻结
最终颗粒、采用关联与来源摘要（此后修改草稿不会改写既有证据）；复核员逐条对采用关联记录
“确认 / 否决”，全部确认方可标记 **已证实**，任一否决立即转为 **需重裁决**。
证据单在创建与每次提交后写透持久化，服务重启后按编号恢复。

项目零第三方运行时依赖（Node.js 标准库），从空仓库交付 `Dockerfile` 与 `docker-compose.yml`，
宿主机端口可配置、应用带健康检查，并含名为 **verify** 的一次性服务：
自动执行构建检查、单元测试、API 冒烟与证据单重启恢复验收后以退出码结束。

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
- 证据单持久化：应用容器内目录 `DATA_DIR`（默认 `/app/data`）挂载命名卷 `review-data`，
  服务重启后证据单按编号恢复；本地运行时默认写到项目根目录 `./data`（已加入 `.gitignore`）；
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

裁决成功后，分析员以当时完整草稿创建证据单；服务端**重新裁决**并冻结最终颗粒、
采用关联与来源摘要（容差、视野数、观测数、逐视野摘要、草稿指纹），此后对草稿的任何
修改都不会改写既有证据单。复核员对每条采用关联（含两端观测、类别与坐标差 Δx/Δy/曼哈顿差）
记录“确认”或“否决”：

- 全部关联均获确认 → 状态变为 **已证实**（`verified`）；
- 任一关联被否决 → 立即转为 **需重裁决**（`needs-readjudication`），
  `firstRejectedLinkIndex` 指出首条阻止本次颗粒计数被证实的显微关联；
- 无采用关联的证据单创建即为已证实。

**并发与幂等**：每次复核提交携带证据单当前 `version` 与唯一 `operationId`——
同操作号同内容重试返回原结果；同操作号不同内容、或版本过期，均返回 `409` 且证据单不变。

**持久化**：创建与每次提交后证据单写透到 `DATA_DIR`（临时文件 + 原子改名），
服务重启后按编号恢复（含复核进度与操作号台账，编号单调递增不回退）。

### `POST /api/review-tickets`

请求体与 `POST /api/particle-deduplications` 相同（完整草稿）。校验失败返回 `400`（可定位 issues），
超出求解规模返回 `422`。成功返回 `201` 与证据单完整视图：

```json
{
  "id": 1,
  "createdAt": "2026-09-25T08:00:00.000Z",
  "updatedAt": "2026-09-25T08:00:00.000Z",
  "version": 0,
  "status": "pending",
  "source": {
    "tolerance": 5, "fieldCount": 3, "observationCount": 7,
    "fields": [{ "name": "F1", "offset": { "x": 0, "y": 0 }, "particleCount": 3 }],
    "draftHash": "sha256…"
  },
  "draft": { "tolerance": 5, "fields": [] },
  "result": { "totalParticles": 5, "linkCount": 2, "particles": [] },
  "links": [
    {
      "index": 0, "particleId": 2, "category": "PP",
      "a": { "fieldName": "F1", "particleId": "A2", "filterX": 40, "filterY": 40 },
      "b": { "fieldName": "F3", "particleId": "C1", "filterX": 40, "filterY": 42 },
      "dx": 0, "dy": 2, "manhattan": 2,
      "decision": "pending", "decidedAt": null
    }
  ],
  "progress": { "total": 2, "confirmed": 0, "rejected": 0, "remaining": 2 },
  "firstRejectedLinkIndex": null
}
```

### `GET /api/review-tickets` / `GET /api/review-tickets/:id`

前者返回全部证据单摘要（编号、状态、进度、首条否决关联、来源概览）；
后者按编号返回完整视图，不存在返回 `404`。

### `POST /api/review-tickets/:id/reviews`

```json
{
  "version": 0,
  "operationId": "web-t1-v0-1a2b3c",
  "decisions": [
    { "linkIndex": 0, "decision": "confirmed" },
    { "linkIndex": 1, "decision": "rejected" }
  ]
}
```

- `200`：已应用（或同操作号同内容的幂等重试，返回原结果），响应为最新证据单视图；
- `400`：提交不合规（非法结论、linkIndex 越界/重复、缺版本/操作号等），证据单不变；
- `404`：证据单不存在；
- `409`：`VERSION_CONFLICT`（版本过期）或 `OPERATION_CONFLICT`（同操作号不同内容），证据单不变。

---

## 前端使用

- 录入 3–5 个视野（可增删），每个视野填写名称（可选）、平移 X/Y 与颗粒表（编号、X、Y、类别，类别带常用聚合物候选）；
- 草稿实时保存在浏览器 `localStorage`，刷新或校验失败均不丢失；
- 点击 **发起去重裁决** 调用 `POST /api/particle-deduplications`：
  - 成功：展示最终颗粒总数，以及每个颗粒的类别、代表坐标、观测明细（视野 / 编号 / 局部坐标 / 滤膜坐标）与所选关联（含曼哈顿差）；
  - 失败：列出全部可定位问题（`fields[1].particles[0].x` 形式）并高亮对应输入框，草稿保留；
- 裁决成功后点击 **创建复测证据单**：服务端以当时完整草稿重新裁决并冻结，此后修改草稿不影响证据单；
- **复测证据单** 面板持续显示冻结来源、复核进度（已确认 / 已否决 / 剩余）与首条否决关联；
  复核员逐条点击“确认 / 否决”后 **提交复核结论**（自动携带当前版本与由内容确定的唯一操作号，
  网络重试即为幂等重试；版本冲突时自动刷新为最新证据单）；
- **载入示例** 可一键填充演示数据。

## 项目结构

```
├── Dockerfile              # 应用镜像（含 HEALTHCHECK，零依赖，非 root 运行）
├── docker-compose.yml      # app（端口可配置 + 证据单数据卷）+ verify（一次性验收）
├── package.json            # 无第三方依赖
├── src/
│   ├── server.js           # HTTP 服务：API 路由、静态资源、健康检查
│   ├── validation.js       # 输入校验（可定位 issues）
│   ├── dedup.js            # 精确求解器（分支定界 + 字典序构造）
│   └── tickets.js          # 复测证据单：冻结裁决、版本/操作号幂等、写透持久化
├── public/                 # 录入、结果展示与证据单复核前端（原生 HTML/JS/CSS）
├── test/                   # 单元测试 + 随机化暴力对拍 + 证据单测试
└── scripts/
    ├── verify.js           # 一次性验收：构建检查 → 测试 → API 冒烟 → 重启恢复 → 退出码
    └── smoke.js            # API 冒烟验收（可独立对运行中的服务执行）
```
