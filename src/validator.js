/** 领域事件信封的基础校验（不依赖外部包）。 */

const REQUIRED = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
];

const EVENT_TYPES = new Set([
  "EXPOSURE_REPORTED",
  "OBSERVATION_ADDED",
  "GUIDANCE_ISSUED",
  "CASE_ESCALATED",
  "TREATMENT_RECORDED",
  "RULE_VETTED",
  "LINKAGE_PROPOSED",
  "LINKAGE_RESOLVED",
  "CLUSTER_ALERTED",
]);

const AGGREGATE_TYPES = new Set([
  "exposure_case",
  "triage_rule",
  "exposure_linkage",
  "public_alert",
]);

/**
 * @returns {string[]} 错误信息数组；为空表示通过。
 */
export function validateEvent(record) {
  const errors = [];
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return ["事件必须是对象"];
  }
  for (const name of REQUIRED) {
    if (!(name in record)) errors.push(`缺少字段：${name}`);
  }
  if (errors.length > 0) return errors;

  if (typeof record.event_id !== "string" || record.event_id.length === 0)
    errors.push("event_id 必须是非空字符串");
  if (!EVENT_TYPES.has(record.event_type)) errors.push(`未知事件类型：${record.event_type}`);
  if (!AGGREGATE_TYPES.has(record.aggregate_type))
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  if (typeof record.aggregate_id !== "string" || record.aggregate_id.length === 0)
    errors.push("aggregate_id 必须是非空字符串");
  if (!Number.isInteger(record.version) || record.version < 1)
    errors.push("version 必须是正整数");
  if (typeof record.summary !== "string" || record.summary.length === 0)
    errors.push("summary 必须是非空字符串");
  const ms = Date.parse(record.occurred_at);
  if (!Number.isFinite(ms)) errors.push("occurred_at 必须是合法时间");
  if ("idempotency_key" in record && typeof record.idempotency_key !== "string")
    errors.push("idempotency_key 必须是字符串");
  if ("payload" in record && (record.payload === null || typeof record.payload !== "object"))
    errors.push("payload 必须是对象");
  return errors;
}
