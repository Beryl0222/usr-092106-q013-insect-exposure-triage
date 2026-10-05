import assert from "node:assert/strict";
import { test } from "node:test";

import { validateEvent } from "../src/validator.js";

const envelope = {
  event_id: "e1",
  event_type: "EXPOSURE_REPORTED",
  aggregate_type: "exposure_case",
  aggregate_id: "case-1",
  occurred_at: "2026-10-04T19:00:00+08:00",
  version: 1,
  summary: "接触登记",
};

test("合法事件信封通过校验", () => {
  assert.deepEqual(validateEvent(envelope), []);
});

test("缺字段、坏版本、坏时间、未知类型被拒绝", () => {
  assert.match(validateEvent({})[0], /缺少字段/);
  assert.ok(validateEvent({ ...envelope, version: 0 }).some((m) => m.includes("version")));
  assert.ok(validateEvent({ ...envelope, occurred_at: "not-a-time" }).some((m) => m.includes("时间")));
  assert.ok(validateEvent({ ...envelope, event_type: "BOGUS" }).some((m) => m.includes("事件类型")));
  assert.ok(validateEvent({ ...envelope, aggregate_type: "patient" }).some((m) => m.includes("聚合类型")));
  assert.ok(validateEvent(null).length > 0);
});
