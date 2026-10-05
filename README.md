# 虫害暴露分诊协同

西安市雨后隐翅虫暴露高发场景下的分诊协同领域服务。统一接收居民 App、社区热线、
医院急诊、疾控转发等渠道的记录，做到：

- 同一次暴露跨渠道**归并**为同一病例，但**绝不因同名合并不同患者**；
- 居民每补充一次症状，都得到**唯一且当前有效**的行动指引（清洗 / 观察 / 尽快就医），
  建议**展示触发项、声明不能替代医生**，新观察可以推翻旧建议；
- 接诊机构**接得上此前经过**（接触、演变、自行处理、他院处置、授权图像）；
- 疾控只看到**达到隐私阈值后的地点级脱敏聚集趋势**，看不到身份与原图；
- 重复上报、乱序到达、离线补录**不会产生相互冲突的提醒**。

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `contracts/domain.schema.json` | 领域事件 JSON Schema（信封 + 各事件类型载荷） |
| `src/domain.ts` | 事件与读模型的 TypeScript 类型 |
| `src/validator.js` | 事件信封基础校验（无外部依赖） |
| `src/rules.js` | 经审核的分诊规则库与纯函数评估器 |
| `src/triage-store.js` | 事件接收、跨渠道归并、分诊投影、提醒账本、聚集预警、分角色视图 |
| `scripts/build-samples.mjs` | 生成联调样例到 `data/generated/` |
| `data/sample.json` | 单条中文样例事件 |
| `data/generated/` | 完整跨渠道场景：源事件、引擎派生事件、三类角色视图 |
| `tests/` | 信封校验、业务场景、样例回放（乱序一致性）测试 |

## 事件模型

事件只追加（event sourcing）。事件的 `event_id / occurred_at / version` 一经接收不原地改写；
对既往症状的更正通过后继观察的 `revises_observation_id` 表达，历史建议以
`supersedes_event_ids` 链保留可追溯性。

| 事件 | 方向 | 用途 |
| --- | --- | --- |
| `EXPOSURE_REPORTED` | 渠道 → 服务 | 接触登记（时间、地点、患者假名、基础风险、图像授权） |
| `OBSERVATION_ADDED` | 渠道 → 服务 | 症状演变、已采取措施、随访图像 |
| `TREATMENT_RECORDED` | 医疗机构 → 服务 | 接诊处置（住院/转诊/出院等），构成建议地板 |
| `RULE_VETTED` | 临床审核 → 服务 | 规则审核启用；未审核的规则不参与任何分诊 |
| `LINKAGE_PROPOSED / LINKAGE_RESOLVED` | 服务 / 数据治理 | 无法自动判定时的归并提案与人工裁决 |
| `GUIDANCE_ISSUED` | 服务**派生** | 某一临床时点的自动建议（含全部触发项） |
| `CASE_ESCALATED` | 服务**派生** | 首次达到升级条件（严重皮损/敏感部位/全身症状/在医处置） |
| `CLUSTER_ALERTED` | 服务**派生** | 地点聚集达到隐私阈值后的区级脱敏预警 |

派生事件可由源事件完整重建，因此重复投递、乱序、离线补录后最终状态必然一致。

## 归并规则（不武断合并）

按优先级：

1. **显式病例号** `case_id`：最权威；
2. **跨渠道令牌** `link_tokens`（热线工单号、App 回执码等）：命中唯一病例即归并；
3. **强关联键** `患者稳定假名 + 接触时刻（精确到时间戳）+ 地点`：三者一致才自动归并；
4. 其余情况一律**新建病例**。同一假名在同地点相近时间存在另一条登记时，
   只生成 `LINKAGE_PROPOSED` 交数据治理人工 `merge/reject`，不自动合并。

患者使用稳定假名 `patient_ref`（非姓名）；姓名字段 `display_name` 永不参与归并。
身份不足以归属的观察先进入挂起队列，后续暴露事件到达时自动归位，不丢失、不错并。

## 分诊规则

规则全部内置在 `src/rules.js`，只有收到对应版本的 `RULE_VETTED` 后才生效，
且评估历史时点时只使用该时点之前已审核的版本（不追溯改写历史建议）。

- `clean`：72 小时内接触、暂无皮损 → 流动清水冲洗、禁用酒精/碘酒/牙膏等刺激物；
- `observe`：小片轻症红斑、已采取刺激性自行处理、症状在进展；
- `seek_care`（升级）：**大面积红斑（≥100 cm²）、水疱、脓疱、糜烂渗出、快速扩展**、
  眼/面/会阴受累、发热等全身症状、婴幼儿/老人/免疫低下且在加重；
- **医疗处置地板**：已有住院/紧急转诊处置后，自动建议不得下调到尽快就医以下。

每条建议携带 `triggered_items`（规则号、版本、原因、命中事实）与固定免责声明。
## 提醒一致性

`notifications` 是完全由事件流重放得到的派生账本，每次接收后整体重算：

- 指引提醒按“病例 + 相邻内容变化”编号：级别/触发项/动作/在医状态不变则不重复提醒；
- 旧提醒自动置为 `superseded`，居民端始终只有一条 `current`；
- 建议级别被新观察推翻后再次升级，是一条新的有效提醒，与历史不冲突；
- 人工合并病例后，旧病例提醒置为 `withdrawn`，渠道侧应撤回展示。

## 聚集预警与隐私

- 采用**固定时间桶**（默认 72 小时对齐桶，而非滑动窗口），桶内离线补录不会反复产生新预警；
- 同一时间桶、同一地点的**不同居民假名数**达到阈值（默认 k=5，联调样例取 3）才发布预警；
  热线坐席等上报方标识、无稳定假名的匿名上报均不计入人数；
- 预警只含区级地点名、时间窗、人数**分箱区间**、脱敏症状标签与可疑虫种，
  不含姓名、假名、精确地址、图像；
- 疾控视图（`cdcView()`）不暴露任何病例字段；待裁决归并队列（`linkageQueue()`）
  属于数据治理职责，队列中同样不回传患者假名。

图像只存指针（`image_ref`），授权范围 `none | clinical`：
`clinical` 仅对接诊机构视图开放，疾控在任何授权级别都拿不到原图。

## 本地检查

```bash
npm install
npm test          # node:test，22 个用例
npm run typecheck # TypeScript 类型检查
npm run build-samples   # 重新生成 data/generated/ 联调样例
```

## 最小用法

```js
import { TriageStore } from "./src/triage-store.js";
import { vettingEvents, RULE_REGISTRY } from "./src/rules.js";

const store = new TriageStore();
store.ingestBatch(
  vettingEvents(RULE_REGISTRY.map((r) => r.rule_id),
    { vetted_by: "市疾控临床审核组", vetted_at: "2026-09-01T09:00:00+08:00" }),
);
store.ingest(exposureEvent);
store.ingest(observationEvent);

store.residentView(caseId);  // 居民：唯一当前指引 + 触发项 + 历史
store.clinicianView(caseId); // 机构：完整时间线 + 授权图像门控
store.cdcView();             // 疾控：脱敏聚集预警
```
