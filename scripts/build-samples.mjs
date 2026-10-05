// 一次性生成联调样例：运行 node scripts/build-samples.mjs
import { writeFile, mkdir } from "node:fs/promises";

import { vettingEvents, RULE_REGISTRY } from "../src/rules.js";
import { TriageStore } from "../src/triage-store.js";

const FIXED_NOW = "2026-10-05T10:20:00+08:00";
const PARK = {
  location_id: "L-XFLD-01",
  location_name: "幸福林带健身区",
  district: "新城区",
  address: "（临床可见，不进入公共预警）",
};
const SCHOOL = { location_id: "L-HZM-02", location_name: "后宰门小学操场", district: "新城区" };

const store = new TriageStore({ now: () => new Date(FIXED_NOW), privacyThreshold: 3, bandSize: 2 });

// 0) 规则审核启用（经市疾控临床审核组审核后才参与分诊）
store.ingestBatch(
  vettingEvents(RULE_REGISTRY.map((r) => r.rule_id), {
    vetted_by: "市疾控临床审核组",
    vetted_at: "2026-09-01T09:00:00+08:00",
  }),
);

// 1) 居民 App 自助登记：雨后傍晚在林带接触疑似隐翅虫，暂无皮损
const exposureApp = {
  event_id: "20261004-APP-7781",
  event_type: "EXPOSURE_REPORTED",
  aggregate_type: "exposure_case",
  aggregate_id: "20261004-APP-7781",
  occurred_at: "2026-10-04T19:02:00+08:00",
  version: 1,
  idempotency_key: "resident-app:msg-88123",
  summary: "居民App登记林带隐翅虫接触，暂无皮损",
  payload: {
    reporter: { channel: "resident_app", reporter_ref: "app-user-7742" },
    link_tokens: ["XA-TRIAGE-20261004-0007"],
    patient: {
      patient_ref: "pid-62001",
      display_name: "乐乐",
      age_group: "child",
      baseline_risks: [],
    },
    contact: {
      occurred_at: "2026-10-04T18:20:00+08:00",
      location: PARK,
      suspected_agent: "隐翅虫",
    },
    note: "孩子在健身器材附近拍落过一只橘黑相间小虫",
  },
};
store.ingest(exposureApp);
const caseId = [...store.cases.values()].find((c) => c.exposures.includes(exposureApp)).case_id;

// 2) 社区卫生服务中心热线回访：家长已涂酒精，出现小片红斑
store.ingest({
  event_id: "20261004-HOTLINE-3320",
  event_type: "OBSERVATION_ADDED",
  aggregate_type: "exposure_case",
  aggregate_id: "20261004-HOTLINE-3320",
  occurred_at: "2026-10-04T21:10:00+08:00",
  version: 1,
  idempotency_key: "hotline:call-55120",
  summary: "热线回访：已涂酒精，前臂小片红斑",
  payload: {
    link_tokens: ["XA-TRIAGE-20261004-0007"],
    observed_at: "2026-10-04T21:00:00+08:00",
    findings: [{ code: "erythema", severity: "mild", area_cm2: 8 }],
    measures: [{ code: "alcohol_applied", at: "2026-10-04T20:30:00+08:00" }],
    evolution: "stable",
    image: {
      image_ref: "obj://images/2026/10/04/55120-01",
      consent_scope: "clinical",
      granted_at: "2026-10-04T21:05:00+08:00",
    },
    note: "家长咨询能否继续涂酒精",
  },
});

// 3) 次日早晨急诊前 App 离线补录（网络恢复后上传，事件接收晚于临床时间）：水疱并快速扩展
store.ingest({
  event_id: "20261005-APP-7782",
  event_type: "OBSERVATION_ADDED",
  aggregate_type: "exposure_case",
  aggregate_id: "20261005-APP-7782",
  occurred_at: "2026-10-05T09:48:00+08:00",
  version: 1,
  idempotency_key: "resident-app:msg-88130",
  summary: "离线补录：晨起出现水疱并向上臂扩展",
  payload: {
    case_id: caseId,
    observed_at: "2026-10-05T07:30:00+08:00",
    findings: [
      { code: "blister", severity: "severe", observed_since: "2026-10-05T06:40:00+08:00" },
      { code: "rapid_spread", severity: "severe", spreading: true },
    ],
    evolution: "worsening",
  },
});

// 4) 医院急诊接诊单（另一家医院也能凭病例号接续经过）
store.ingest({
  event_id: "20261005-ED-0091",
  event_type: "TREATMENT_RECORDED",
  aggregate_type: "exposure_case",
  aggregate_id: caseId,
  occurred_at: "2026-10-05T10:10:00+08:00",
  version: 1,
  idempotency_key: "ed:visit-20261005-0091",
  summary: "市儿童医院急诊收治",
  payload: {
    case_id: caseId,
    institution_id: "H-XACHILD",
    institution_name: "西安市儿童医院急诊",
    treated_at: "2026-10-05T10:05:00+08:00",
    disposition: "admitted",
    diagnosis_suspected: "隐翅虫皮炎（条索状水疱性皮炎）",
    actions: ["创面清洁护理", "收住皮肤科观察"],
    note: "嘱家长勿再使用酒精",
  },
});

// 5) 另一家医院同夜也接诊一个同名"乐乐"——不同稳定假名、不同地点，绝不可并为一人
store.ingest({
  event_id: "20261004-ED-0417",
  event_type: "EXPOSURE_REPORTED",
  aggregate_type: "exposure_case",
  aggregate_id: "20261004-ED-0417",
  occurred_at: "2026-10-04T23:40:00+08:00",
  version: 1,
  idempotency_key: "ed:visit-20261004-0417",
  summary: "另一家医院接诊同名患儿（不同人，独立病例）",
  payload: {
    reporter: { channel: "hospital", reporter_ref: "H-XAJT" },
    patient: { patient_ref: "pid-62088", display_name: "乐乐", age_group: "child" },
    contact: {
      occurred_at: "2026-10-04T17:10:00+08:00",
      location: SCHOOL,
      suspected_agent: "隐翅虫",
    },
  },
});

// 6) 林带同时间窗另外两位居民上报，达到隐私阈值 k=3 → 区级公共预警
for (const [i, ref] of ["pid-62045", "pid-62067"].entries()) {
  store.ingest({
    event_id: `20261004-CDC-FWD-${10 + i}`,
    event_type: "EXPOSURE_REPORTED",
    aggregate_type: "exposure_case",
    aggregate_id: `20261004-CDC-FWD-${10 + i}`,
    occurred_at: `2026-10-04T20:1${i}:00+08:00`,
    version: 1,
    idempotency_key: `cdc-forward:20261004-${10 + i}`,
    summary: "社区上报林带附近暴露",
    payload: {
      reporter: { channel: "cdc_forward" },
      patient: { patient_ref: ref, age_group: "adult" },
      contact: {
        occurred_at: `2026-10-04T18:${i === 0 ? "25" : "40"}:00+08:00`,
        location: PARK,
        suspected_agent: "隐翅虫",
      },
    },
  });
}

await mkdir(new URL("../data/generated/", import.meta.url), { recursive: true });

// 源事件（外部渠道投递格式），剔除引擎派生事件
const sourced = [...store.events.values()].filter(
  (e) =>
    !["GUIDANCE_ISSUED", "CASE_ESCALATED", "CLUSTER_ALERTED"].includes(e.event_type),
);
await writeFile(
  new URL("../data/generated/scenario-events.json", import.meta.url),
  JSON.stringify(sourced, null, 2) + "\n",
);

const derived = [...store.events.values()].filter((e) =>
  ["GUIDANCE_ISSUED", "CASE_ESCALATED", "CLUSTER_ALERTED"].includes(e.event_type),
);
await writeFile(
  new URL("../data/generated/scenario-derived.json", import.meta.url),
  JSON.stringify(derived, null, 2) + "\n",
);

await writeFile(
  new URL("../data/generated/views.json", import.meta.url),
  JSON.stringify(
    {
      resident: store.residentView(caseId),
      clinician: store.clinicianView(caseId),
      cdc: store.cdcView(),
      notifications: store.notifications,
    },
    null,
    2,
  ) + "\n",
);

console.log(`源事件 ${sourced.length} 条，派生事件 ${derived.length} 条，已写入 data/generated/`);
