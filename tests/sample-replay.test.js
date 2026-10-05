import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { TriageStore } from "../src/triage-store.js";

const FIXED_NOW = "2026-10-05T10:20:00+08:00";
const url = (f) => new URL(`../data/generated/${f}`, import.meta.url);

function replay(events, shuffle = false) {
  const s = new TriageStore({ now: () => new Date(FIXED_NOW), privacyThreshold: 3, bandSize: 2 });
  const ordered = shuffle ? [...events].reverse() : events;
  s.ingestBatch(ordered);
  return s;
}

test("联调样例可回放并产出一致的分诊、预警与通知", async () => {
  const events = JSON.parse(await readFile(url("scenario-events.json"), "utf8"));
  const s1 = replay(events);
  const s2 = replay(events, true); // 逆序投递也应收敛到同一结果

  const fingerprint = (s) => ({
    cases: [...s.cases.values()]
      .filter((c) => c.status === "active")
      .map((c) => ({
        id: c.case_id,
        exposures: c.exposures.length,
        observations: c.observations.length,
        treatments: c.treatments.length,
        level: s.residentView(c.case_id)?.current_guidance?.level ?? null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    notifications: s.notifications
      .map((n) => `${n.key}|${n.status}`)
      .sort(),
    alerts: s.cdcView().cluster_alerts.map((a) => `${a.location_id}|${a.distinct_residents_band}`),
  });

  assert.deepEqual(fingerprint(s1), fingerprint(s2), "乱序重放结果不一致");

  // 同名不同人未被合并：共 4 个活跃病例（林带患儿、同名患儿、另 2 位居民）
  const activeCases = fingerprint(s1).cases;
  assert.equal(activeCases.length, 4);

  // 主病例：clean → observe → seek_care
  const main = activeCases.find((c) => c.exposures === 1 && c.observations === 2 && c.treatments === 1);
  assert.ok(main);
  assert.equal(main.level, "seek_care");

  // 当前建议必须展示触发项，且声明不能替代医生
  const g = s1.residentView(main.id).current_guidance;
  assert.ok(g.triggered_items.length > 0, "建议必须展示触发项");
  assert.ok(g.triggered_items.some((t) => t.reason_code === "severe_skin_sign"));
  assert.ok(g.disclaimer.includes("不能替代医生"));

  // 唯一当前的聚集预警，达到阈值且脱敏
  assert.deepEqual(s1.cdcView().cluster_alerts.map((a) => a.distinct_residents_band), ["3-4"]);
  const cdcRaw = JSON.stringify(s1.cdcView());
  assert.ok(!cdcRaw.includes("pid-"));
  assert.ok(!cdcRaw.includes("乐乐"));
});

test("规则未经审核时不产生任何自动建议", async () => {
  const events = JSON.parse(await readFile(url("scenario-events.json"), "utf8"));
  const withoutVetting = new TriageStore({ now: () => new Date(FIXED_NOW), privacyThreshold: 3, bandSize: 2 });
  withoutVetting.ingestBatch(events.filter((e) => e.event_type !== "RULE_VETTED"));
  assert.equal([...withoutVetting.cases.values()].every((c) => (c.derivedGuidance ?? []).length === 0), true);
});
