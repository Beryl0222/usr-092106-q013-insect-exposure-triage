import assert from "node:assert/strict";
import { test } from "node:test";

import { TriageStore } from "../src/triage-store.js";
import { vettingEvents, RULE_REGISTRY, LARGE_AREA_CM2 } from "../src/rules.js";

const FIXED_NOW = "2026-10-05T10:00:00+08:00";
const VET_AT = "2026-09-01T00:00:00+08:00";
const PARK = { location_id: "L-PARK", location_name: "幸福林带健身区", district: "新城区", address: "某路 1 号" };
const SCHOOL = { location_id: "L-SCHOOL", location_name: "后宰门小学", district: "新城区" };

let seq = 0;
const nextId = (p) => `${p}-${(++seq).toString(36)}`;

function store(opts = {}) {
  return new TriageStore({ now: () => new Date(FIXED_NOW), privacyThreshold: 3, bandSize: 2, ...opts });
}

function withVettings(s) {
  s.ingestBatch(vettingEvents(RULE_REGISTRY.map((r) => r.rule_id), { vetted_by: "市疾控临床审核组", vetted_at: VET_AT }));
  return s;
}

function exposure({
  id = nextId("exp"),
  at = "2026-10-04T19:00:00+08:00",
  contactAt = "2026-10-04T18:30:00+08:00",
  location = PARK,
  patientRef = "p-001",
  name,
  ageGroup = "child",
  channel = "resident_app",
  tokens,
  caseId,
  image,
  idem,
  baselineRisks,
  summary = "接触登记",
}) {
  return {
    event_id: id,
    event_type: "EXPOSURE_REPORTED",
    aggregate_type: "exposure_case",
    aggregate_id: id,
    occurred_at: at,
    version: 1,
    summary,
    ...(idem ? { idempotency_key: idem } : {}),
    payload: {
      reporter: { channel },
      ...(caseId ? { case_id: caseId } : {}),
      ...(tokens ? { link_tokens: tokens } : {}),
      ...(patientRef ? { patient_ref: patientRef } : {}),
      patient: {
        ...(patientRef ? { patient_ref: patientRef } : {}),
        ...(name ? { display_name: name } : {}),
        age_group: ageGroup,
        ...(baselineRisks ? { baseline_risks: baselineRisks } : {}),
      },
      contact: { occurred_at: contactAt, location, suspected_agent: "隐翅虫" },
      ...(image ? { image } : {}),
    },
  };
}

function observation({
  id = nextId("obs"),
  at = "2026-10-04T21:00:00+08:00",
  observedAt = at,
  findings = [],
  measures = [],
  evolution,
  caseId,
  tokens,
  patientRef,
  image,
  revises,
  note,
  summary = "症状随访",
}) {
  return {
    event_id: id,
    event_type: "OBSERVATION_ADDED",
    aggregate_type: "exposure_case",
    aggregate_id: id,
    occurred_at: at,
    version: 1,
    summary,
    payload: {
      observed_at: observedAt,
      ...(caseId ? { case_id: caseId } : {}),
      ...(tokens ? { link_tokens: tokens } : {}),
      ...(patientRef ? { patient_ref: patientRef } : {}),
      ...(findings.length ? { findings } : {}),
      ...(measures.length ? { measures } : {}),
      ...(evolution ? { evolution } : {}),
      ...(image ? { image } : {}),
      ...(revises ? { revises_observation_id: revises } : {}),
      ...(note ? { note } : {}),
    },
  };
}

function treatment({ id = nextId("trt"), caseId, at = "2026-10-05T09:30:00+08:00", disposition = "admitted" }) {
  return {
    event_id: id,
    event_type: "TREATMENT_RECORDED",
    aggregate_type: "exposure_case",
    aggregate_id: caseId ?? id,
    occurred_at: at,
    version: 1,
    summary: "医疗机构处置",
    payload: {
      case_id: caseId ?? id,
      institution_id: "H-001",
      institution_name: "市儿童医院",
      treated_at: at,
      disposition,
      diagnosis_suspected: "隐翅虫皮炎",
      actions: ["创面护理", "随诊"],
    },
  };
}

function seededCase(s, { patientRef = "p-001", tokens, image, name } = {}) {
  const e = exposure({ patientRef, tokens, image, name });
  s.ingest(e);
  return [...s.cases.values()].find((c) => c.exposures.includes(e)).case_id;
}

const current = (s, caseId) => s.residentView(caseId).current_guidance;
const guidanceNotifications = (s, caseId) =>
  s.notifications.filter((n) => n.type === "GUIDANCE_ISSUED" && n.case_id === caseId);

// ---------------------------------------------------------------- 规则审核门控

test("规则未经审核不产生自动建议；审核生效后才分诊", () => {
  const s = store();
  const cid = seededCase(s, {});
  assert.equal(current(s, cid), null, "无审核规则时不给出建议");

  s.ingest(vettingEvents(["R-CONTACT-CLEAN"], { vetted_by: "审核组", vetted_at: VET_AT })[0]);
  assert.equal(current(s, cid).level, "clean");
  assert.ok(current(s, cid).disclaimer.includes("不能替代医生"));
});

test("历史时点不使用之后才审核通过的规则（不追溯改写）", () => {
  const s = store();
  const cid = seededCase(s, {});
  // 观察发生在 10-04，规则 10-05 才审核
  s.ingest(observation({ id: "o-late", caseId: cid, at: "2026-10-04T20:00:00+08:00", observedAt: "2026-10-04T20:00:00+08:00", findings: [{ code: "blister", severity: "severe" }] }));
  // 全部规则 10-05 08:00 才审核通过
  s.ingestBatch(vettingEvents(RULE_REGISTRY.map((r) => r.rule_id), { vetted_by: "审核组", vetted_at: "2026-10-05T08:00:00+08:00" }));
  // 审核之前的观察点不产生建议；审核后补一条新观察才触发
  const levels = s.residentView(cid).history.map((h) => h.level);
  assert.deepEqual(levels, []);
  s.ingest(observation({ caseId: cid, observedAt: "2026-10-05T09:00:00+08:00", at: "2026-10-05T09:00:00+08:00", findings: [{ code: "blister", severity: "severe" }] }));
  assert.equal(current(s, cid).level, "seek_care");
});

// ---------------------------------------------------------------- 分诊升级路径

test("清洗→观察→尽快就医：错误酒精处理与水疱升级，均展示触发项", () => {
  const s = withVettings(store());
  const cid = seededCase(s, {});
  assert.equal(current(s, cid).level, "clean");

  s.ingest(observation({
    caseId: cid,
    findings: [{ code: "erythema", severity: "mild", area_cm2: 9 }],
    measures: [{ code: "alcohol_applied" }],
    evolution: "stable",
  }));
  const obs = current(s, cid);
  assert.equal(obs.level, "observe");
  assert.deepEqual(obs.triggered_items.map((t) => t.reason_code).sort(), ["harmful_self_measure", "mild_local_erythema"]);
  assert.ok(obs.actions.some((a) => a.includes("停止")));

  s.ingest(observation({
    caseId: cid, observedAt: "2026-10-05T08:00:00+08:00", at: "2026-10-05T09:55:00+08:00",
    findings: [{ code: "blister", severity: "severe" }, { code: "rapid_spread", severity: "severe" }],
    evolution: "worsening",
  }));
  const urgent = current(s, cid);
  assert.equal(urgent.level, "seek_care");
  assert.ok(urgent.triggered_items.some((t) => t.reason_code === "severe_skin_sign" && t.escalates));
  assert.equal(s.cases.get(cid).escalated, true);

  const notifs = guidanceNotifications(s, cid);
  assert.equal(notifs.filter((n) => n.status === "current").length, 1);
  assert.deepEqual(notifs.filter((n) => n.status === "superseded").map((n) => n.level), ["clean", "observe"]);
});

test("大面积红斑、脓疱、糜烂渗出均触发升级", () => {
  for (const finding of [
    { code: "erythema", severity: "severe", area_cm2: LARGE_AREA_CM2 + 10 },
    { code: "pustule", severity: "severe" },
    { code: "erosion_oozing", severity: "severe" },
  ]) {
    const s = withVettings(store());
    const cid = seededCase(s, {});
    s.ingest(observation({ caseId: cid, observedAt: "2026-10-05T08:00:00+08:00", findings: [finding] }));
    assert.equal(current(s, cid).level, "seek_care", `${finding.code} 应升级`);
    assert.equal(s.cases.get(cid).escalated, true);
  }
});

test("眼面/会阴受累、全身症状、脆弱人群加重均升级", () => {
  const cases = [
    { findings: [{ code: "eye_involvement", severity: "severe" }] },
    { findings: [{ code: "systemic_symptom", severity: "severe" }] },
    { findings: [{ code: "erythema", severity: "mild", area_cm2: 5 }], evolution: "worsening", ageGroup: "infant" },
  ];
  for (const c of cases) {
    const s = withVettings(store());
    const e = exposure({ ageGroup: c.ageGroup ?? "child" });
    s.ingest(e);
    const id = [...s.cases.values()].find((x) => x.exposures.includes(e)).case_id;
    s.ingest(observation({ caseId: id, observedAt: "2026-10-05T08:00:00+08:00", findings: c.findings, evolution: c.evolution }));
    assert.equal(current(s, id).level, "seek_care");
  }
});

// ---------------------------------------------------------------- 新观察推翻旧建议

test("后继观察更正误判后建议下调，历史建议仍可追溯", () => {
  const s = withVettings(store());
  const cid = seededCase(s, {});
  s.ingest(observation({ id: "o-bad", caseId: cid, observedAt: "2026-10-04T22:00:00+08:00", findings: [{ code: "blister", severity: "severe" }] }));
  assert.equal(current(s, cid).level, "seek_care");

  s.ingest(observation({
    caseId: cid, observedAt: "2026-10-05T08:00:00+08:00", revises: "o-bad",
    findings: [{ code: "erythema", severity: "mild", area_cm2: 6 }], evolution: "stable",
  }));
  assert.equal(current(s, cid).level, "observe");
  const levels = s.residentView(cid).history.map((h) => h.level);
  assert.deepEqual(levels, ["clean", "seek_care", "observe"]);
  // 源事件未被删除或改写
  assert.equal(s.events.get("o-bad").payload.findings[0].code, "blister");
  assert.equal(guidanceNotifications(s, cid).filter((n) => n.status === "current").length, 1);
});

// ---------------------------------------------------------------- 幂等、乱序、离线补录

test("重复 event_id 与 idempotency_key 判定为重复投递", () => {
  const s = withVettings(store());
  const e = exposure({ id: "dup-1", idem: "channel-key-1" });
  assert.equal(s.ingest(e).status, "accepted");
  assert.equal(s.ingest({ ...e, event_id: "dup-1-copy" }).status, "duplicate");
  assert.equal(s.ingest({ ...e, event_id: "dup-2" }).status, "duplicate");
  assert.equal(s.cases.size, 1);
});

test("乱序到达与离线补录产生同一最终状态，且不产生冲突提醒", () => {
  const build = () => {
    const s = withVettings(store());
    s.ingest(exposure({ id: "exp1", tokens: ["TOK-1"] }));
    const cid = [...s.cases.keys()][0];
    s.ingest(observation({ id: "ob1", caseId: cid, observedAt: "2026-10-04T21:00:00+08:00", measures: [{ code: "alcohol_applied" }], findings: [{ code: "erythema", severity: "mild", area_cm2: 5 }] }));
    s.ingest(observation({ id: "ob2", caseId: cid, observedAt: "2026-10-05T08:00:00+08:00", at: "2026-10-05T09:55:00+08:00", findings: [{ code: "pustule", severity: "severe" }] }));
    return s;
  };

  // 顺序接收
  const a = build();
  // 乱序接收（先到严重观察，再补轻症随访与暴露）
  const b = withVettings(store());
  const events = [
    observation({ id: "ob2", tokens: ["TOK-1"], observedAt: "2026-10-05T08:00:00+08:00", at: "2026-10-05T09:55:00+08:00", findings: [{ code: "pustule", severity: "severe" }] }),
    exposure({ id: "exp1", tokens: ["TOK-1"] }),
    observation({ id: "ob1", tokens: ["TOK-1"], observedAt: "2026-10-04T21:00:00+08:00", measures: [{ code: "alcohol_applied" }], findings: [{ code: "erythema", severity: "mild", area_cm2: 5 }] }),
  ];
  b.ingestBatch(events);

  const cidA = a.residentView([...a.cases.keys()][0]).case_id;
  const cidB = [...b.cases.keys()][0];
  assert.equal(current(b, cidB).level, current(a, cidA).level);
  assert.equal(current(b, cidB).level, "seek_care");

  const norm = (s) => s.notifications
    .filter((n) => n.type === "GUIDANCE_ISSUED")
    .map((n) => `${n.case_id}|${n.level}|${n.status}`)
    .sort();
  // 病例 id 由内容决定（exp1 相同），通知账本一致
  assert.equal(cidA, cidB);
  assert.deepEqual(norm(a), norm(b));
  const currents = b.notifications.filter((n) => n.type === "GUIDANCE_ISSUED" && n.status === "current");
  assert.equal(currents.length, 1);
});

test("同内容重复补充不再刷出新提醒", () => {
  const s = withVettings(store());
  const cid = seededCase(s, {});
  s.ingest(observation({ caseId: cid, observedAt: "2026-10-04T21:00:00+08:00", findings: [{ code: "erythema", severity: "mild", area_cm2: 5 }] }));
  s.ingest(observation({ caseId: cid, observedAt: "2026-10-04T22:00:00+08:00", findings: [{ code: "erythema", severity: "mild", area_cm2: 5 }], evolution: "stable" }));
  const notifs = guidanceNotifications(s, cid);
  assert.deepEqual(notifs.map((n) => n.level), ["clean", "observe"]);
  assert.equal(notifs.at(-1).status, "current");
});

// ---------------------------------------------------------------- 归并：不武断合并同名

test("跨渠道令牌与强关联键归并同一暴露；同名不同人不合并", () => {
  const s = withVettings(store());
  // App 登记 → 热线凭 token 接续
  const e1 = exposure({ id: "app-1", patientRef: "p-001", name: "乐乐", tokens: ["TOK-9"] });
  s.ingest(e1);
  const cid = [...s.cases.values()].find((c) => c.exposures.includes(e1)).case_id;
  s.ingest(observation({ tokens: ["TOK-9"], measures: [{ code: "alcohol_applied" }] }));

  // 医院同名"乐乐"，假名不同 → 独立病例
  s.ingest(exposure({ id: "hos-1", patientRef: "p-002", name: "乐乐", location: SCHOOL, contactAt: "2026-10-04T17:00:00+08:00" }));
  assert.equal(s.cases.size, 2);
  assert.deepEqual(s.cases.get(cid).observations.length, 1);

  // 强关联键：同假名、同日、同地点的另一条上报自动归并
  s.ingest(exposure({ id: "hot-1", patientRef: "p-001", name: "乐乐", channel: "community_hotline" }));
  assert.equal(s.cases.size, 2);
  assert.equal(s.cases.get(cid).exposures.length, 2);
});

test("同患者同地点相近时间两条独立登记只产生归并提案，不自动合并", () => {
  const s = withVettings(store());
  s.ingest(exposure({ id: "x-a", patientRef: "p-007", contactAt: "2026-10-04T08:00:00+08:00" }));
  s.ingest(exposure({ id: "x-b", patientRef: "p-007", contactAt: "2026-10-04T20:00:00+08:00" }));
  assert.equal(s.cases.size, 2);
  const queue = s.linkageQueue();
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, "pending");
  assert.ok(!JSON.stringify(queue).includes("p-007"), "归并队列不含患者假名");

  // 驳回 → 保持两个病例
  const pid = queue[0].proposal_id;
  s.ingest({
    event_id: "rej-1", event_type: "LINKAGE_RESOLVED", aggregate_type: "exposure_linkage", aggregate_id: pid,
    occurred_at: "2026-10-05T09:00:00+08:00", version: 1, summary: "驳回归并",
    payload: { proposal_id: pid, decision: "reject", resolved_by: "数据治理员", resolved_at: "2026-10-05T09:00:00+08:00" },
  });
  assert.equal(s.cases.size, 2);
  assert.equal(s.linkageQueue().length, 0);
});

test("人工确认合并后历史汇流，旧病例提醒撤回", () => {
  const s = withVettings(store());
  const a = exposure({ id: "m-a", patientRef: "p-009", contactAt: "2026-10-04T18:00:00+08:00" });
  const b = exposure({ id: "m-b", patientRef: "p-009", contactAt: "2026-10-04T19:00:00+08:00" });
  s.ingest(a); s.ingest(b);
  const idA = [...s.cases.values()].find((c) => c.exposures.includes(a)).case_id;
  const idB = [...s.cases.values()].find((c) => c.exposures.includes(b)).case_id;
  s.ingest(observation({ caseId: idB, observedAt: "2026-10-04T21:00:00+08:00", findings: [{ code: "erythema", severity: "mild", area_cm2: 4 }] }));

  const pid = s.linkageQueue()[0].proposal_id;
  s.ingest({
    event_id: "res-1", event_type: "LINKAGE_RESOLVED", aggregate_type: "exposure_linkage", aggregate_id: pid,
    occurred_at: "2026-10-05T09:00:00+08:00", version: 1, summary: "确认同次暴露",
    payload: { proposal_id: pid, decision: "merge", case_id: idA, resolved_by: "数据治理员", resolved_at: "2026-10-05T09:00:00+08:00" },
  });

  assert.equal(s.cases.get(idB).status, "merged");
  assert.equal(s.cases.get(idA).status, "active");
  assert.equal(s.cases.get(idA).exposures.length, 2);
  assert.equal(s.cases.get(idA).observations.length, 1);
  // 旧号仍可解析到新病例
  assert.ok(s.residentView(idB));
  // 旧病例的提醒被撤回，不与新病例提醒并存
  const withdrawn = s.notifications.filter((n) => n.status === "withdrawn");
  assert.ok(withdrawn.some((n) => n.case_id === idB));
});

test("观察先到、暴露后到时挂起并自动归位，不丢失", () => {
  const s = withVettings(store());
  s.ingest(observation({ id: "early", patientRef: "p-021", observedAt: "2026-10-04T21:00:00+08:00", findings: [{ code: "erythema", severity: "mild", area_cm2: 4 }] }));
  assert.equal(s.observationInbox.size, 1);
  s.ingest(exposure({ id: "late-exp", patientRef: "p-021" }));
  assert.equal(s.observationInbox.size, 0);
  const cid = [...s.cases.keys()][0];
  assert.equal(s.cases.get(cid).observations.length, 1);
});

// ---------------------------------------------------------------- 医疗处置地板与接诊接续

test("住院处置后建议不低于尽快就医；接诊机构可接续完整经过", () => {
  const s = withVettings(store());
  const cid = seededCase(s, { image: { image_ref: "img-ok", consent_scope: "clinical", granted_at: "2026-10-04T19:00:00+08:00" } });
  s.ingest(treatment({ caseId: cid }));
  assert.equal(current(s, cid).level, "seek_care");
  assert.equal(current(s, cid).clinical_care_in_progress, true);

  // 之后即使症状变轻也不下调
  s.ingest(observation({ caseId: cid, observedAt: "2026-10-05T09:40:00+08:00", findings: [{ code: "erythema", severity: "mild", area_cm2: 3 }] }));
  assert.equal(current(s, cid).level, "seek_care");

  const view = s.clinicianView(cid);
  const kinds = view.timeline.map((t) => t.kind);
  assert.ok(kinds.includes("exposure_reported"));
  assert.ok(kinds.includes("treatment_recorded"));
  const treatmentRow = view.timeline.find((t) => t.kind === "treatment_recorded");
  assert.equal(treatmentRow.institution_name, "市儿童医院");
  const img = view.timeline.find((t) => t.image?.image_ref === "img-ok");
  assert.ok(img, "clinical 授权图像对临床可见");
});

test("未授权临床图像时机构视图不返回图像引用", () => {
  const s = withVettings(store());
  const cid = seededCase(s, { image: { image_ref: "img-secret", consent_scope: "none", granted_at: "2026-10-04T19:00:00+08:00" } });
  const view = s.clinicianView(cid);
  const row = view.timeline.find((t) => t.image);
  assert.equal(row.image.image_ref, null);
  assert.equal(row.image.consent_scope, "none");
  assert.ok(!JSON.stringify(view).includes("img-secret"));
});

// ---------------------------------------------------------------- 聚集预警与隐私阈值

function clusterResidents(s, refs, location = PARK) {
  refs.forEach((ref, i) => {
    s.ingest(exposure({
      id: `cl-${ref}`, patientRef: ref, channel: "community_hotline", location,
      contactAt: `2026-10-04T1${8 + (i % 2)}:0${i}:00+08:00`,
      name: undefined,
    }));
  });
}

test("未达隐私阈值不预警；达到后预警脱敏、不含身份原图地址", () => {
  const below = withVettings(store());
  clusterResidents(below, ["r1", "r2"]);
  assert.equal(below.cdcView().cluster_alerts.length, 0);

  const s = withVettings(store());
  clusterResidents(s, ["r1", "r2", "r3"]);
  const alerts = s.cdcView().cluster_alerts;
  assert.equal(alerts.length, 1);
  const a = alerts[0];
  assert.equal(a.location_id, "L-PARK");
  assert.equal(a.privacy_threshold, 3);
  assert.equal(a.distinct_residents_band, "3-4");
  // 脱敏：不含精确地址、患者假名、图像
  const raw = JSON.stringify(a);
  assert.ok(!raw.includes("某路"));
  assert.ok(!raw.includes("r1"));
  assert.ok(!raw.includes("image"));

  const alertNotifs = s.notifications.filter((n) => n.type === "CLUSTER_ALERTED");
  assert.equal(alertNotifs.filter((n) => n.status === "current").length, 1);
});

test("固定时间桶内离线补录不重复预警；人数只按不同居民计", () => {
  const s = withVettings(store());
  clusterResidents(s, ["r1", "r2", "r3"]);
  const before = s.cdcView().cluster_alerts[0].event_id ?? s.cdcView().cluster_alerts[0].issued_at;
  // 同一居民重复上报，不增加计数、不产生新预警
  s.ingest(exposure({ id: "dup-resident", patientRef: "r1", channel: "hospital" }));
  const alerts = s.cdcView().cluster_alerts;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].distinct_residents_band, "3-4");
  assert.equal(s.notifications.filter((n) => n.type === "CLUSTER_ALERTED").length, 1);

  // 无稳定居民假名的上报不凑数
  const t = withVettings(store());
  clusterResidents(t, ["r1", "r2"]);
  t.ingest(exposure({ id: "anon", patientRef: null, channel: "community_hotline" }));
  assert.equal(t.cdcView().cluster_alerts.length, 0);
});

test("疾控视图看不到病例身份信息", () => {
  const s = withVettings(store());
  clusterResidents(s, ["r1", "r2", "r3"]);
  seededCase(s, { patientRef: "r1", name: "乐乐" });
  const raw = JSON.stringify(s.cdcView());
  assert.ok(!raw.includes("乐乐"));
  assert.ok(!raw.includes("patient_ref"));
  assert.ok(!raw.includes("display_name"));
});

test("显式病例号取代临时号后，旧号上报仍归入同一病例", () => {
  const s = withVettings(store());
  // 第一条无 case_id → 临时号
  const e = exposure({ id: "alias-exp", tokens: ["TOK-ALIAS"] });
  s.ingest(e);
  const tempId = [...s.cases.values()].find((c) => c.exposures.includes(e)).case_id;
  const official = "XA-CASE-20261004-0099";
  // 热线凭共享令牌复述同一次暴露并回写正式病例号（接触时刻一致）
  s.ingest(exposure({ id: "alias-exp2", caseId: official, tokens: ["TOK-ALIAS"] }));
  assert.equal(s.cases.size, 1);
  // 热线与之后渠道分别用正式号、旧临时号报观察
  s.ingest(observation({ id: "alias-o1", caseId: official, observedAt: "2026-10-04T21:00:00+08:00", findings: [{ code: "erythema", severity: "mild", area_cm2: 4 }] }));
  s.ingest(observation({ id: "alias-o2", caseId: tempId, observedAt: "2026-10-04T22:00:00+08:00", findings: [{ code: "erythema", severity: "mild", area_cm2: 5 }] }));

  const c = s.cases.get(official);
  assert.ok(c);
  assert.equal(c.exposures.length, 2);
  assert.equal(c.observations.length, 2);
  assert.ok(s.residentView(tempId), "旧号视图仍可解析");
  assert.equal(s.residentView(tempId).case_id, official);
});
