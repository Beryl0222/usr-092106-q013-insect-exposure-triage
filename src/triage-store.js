/**
 * 暴露分诊协同核心：事件接收、跨渠道归并、规则分诊投影、提醒幂等与聚集预警。
 *
 * 关键设计：
 * 1. 事件只追加，不原地改写；对既往症状的更正以“后继观察”表达（revises_observation_id）。
 * 2. 归并只认显式 case_id / link_token / 强关联键（患者稳定假名+接触日期+地点），
 *    绝不按同名合并；证据不足时挂起并产生 LINKAGE_PROPOSED，等待人工 LINKAGE_RESOLVED。
 * 3. “当前有效指引”是由完整病史重放得到的单一投影：重复投递、乱序到达、离线补录后，
 *    投影结果一致；指引事件按内容寻址，历史记录保留，旧指引被新指引显式取代。
 * 4. 地点聚集达到隐私阈值（不同居民数）才产生公共预警，预警只含区级脱敏信息。
 */

import { createHash } from "node:crypto";

import { DISCLAIMER, evaluateTriage, LEVEL_RANK } from "./rules.js";
import { validateEvent } from "./validator.js";

const TYPE_ORDER = Object.freeze({
  RULE_VETTED: 0,
  EXPOSURE_REPORTED: 1,
  OBSERVATION_ADDED: 2,
  TREATMENT_RECORDED: 3,
  LINKAGE_PROPOSED: 4,
  LINKAGE_RESOLVED: 5,
  CASE_ESCALATED: 6,
  GUIDANCE_ISSUED: 7,
  CLUSTER_ALERTED: 8,
});

const ACTIVE_CARE_DISPOSITIONS = new Set(["admitted", "referred_urgent"]);

const FINDING_TAGS = Object.freeze({
  erythema: "红斑",
  large_erythema: "大面积红斑",
  blister: "水疱",
  pustule: "脓疱",
  erosion_oozing: "糜烂渗出",
  rapid_spread: "快速扩展",
  eye_involvement: "眼部受累",
  face_genital_involvement: "面/会阴受累",
  systemic_symptom: "全身症状",
});

function shortHash(input) {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

function byOccurred(a, b) {
  const d = Date.parse(a.occurred_at) - Date.parse(b.occurred_at);
  return d !== 0 ? d : (TYPE_ORDER[a.event_type] ?? 9) - (TYPE_ORDER[b.event_type] ?? 9);
}

function status_active(c) {
  return c.status === "active";
}

/** 指引内容指纹：级别、触发项、动作与“在医处置”地板任一不同才算新内容。 */
function guidanceContent(payload) {
  const basis = JSON.stringify({
    level: payload.level,
    items: payload.triggered_items.map((x) => `${x.rule_id}@v${x.rule_version}:${x.reason_code}`),
    actions: payload.actions,
    floor: Boolean(payload.clinical_care_in_progress),
  });
  return { hash: shortHash(basis) };
}

/** 暴露分诊存储与投影。无外部依赖，可整体替换为持久化实现。 */
export class TriageStore {
  /**
   * @param {object} [opts]
   * @param {() => Date} [opts.now] 时钟注入，便于离线补录与窗口测试。
   * @param {number} [opts.privacyThreshold] 公共预警所需的最少不同居民数。
   * @param {number} [opts.clusterWindowMs] 聚集判定时间窗。
   * @param {number} [opts.bandSize] 预警发布的人数分箱宽度。
   * @param {number} [opts.nearbyWindowMs] 同地点近似暴露提议归并的时间窗。
   */
  constructor({
    now = () => new Date(),
    privacyThreshold = 5,
    clusterWindowMs = 72 * 60 * 60 * 1000,
    bandSize = 5,
    nearbyWindowMs = 72 * 60 * 60 * 1000,
  } = {}) {
    this._now = now;
    this.privacyThreshold = privacyThreshold;
    this.clusterWindowMs = clusterWindowMs;
    this.bandSize = bandSize;
    this.nearbyWindowMs = nearbyWindowMs;

    /** @type {Map<string, object>} 全部事件，event_id -> event */
    this.events = new Map();
    /** 渠道原始去重键 -> event_id */
    this.idempotency = new Map();

    /** 规则审核：rule_id -> {version, vetted_at, vetted_by} */
    this.vettings = new Map();

    /** 规范病例：case_id -> case */
    this.cases = new Map();
    /** link_token -> case_id */
    this.tokenIndex = new Map();
    /** 病例旧号 -> 现号（显式 case_id 取代临时号时保留可追溯性） */
    this.caseAliases = new Map();
    /** 强关联键 patient_ref|date|location_id -> case_id */
    this.seedIndex = new Map();
    /** patient_ref -> Set<case_id> */
    this.patientIndex = new Map();

    /** 暂无法判定归属的观察：patient_ref -> [event] */
    this.observationInbox = new Map();

    /** 归并提案：proposal_id -> payload（含状态） */
    this.proposals = new Map();

    /** 上一轮投影产出的派生事件 id（用于重建时做差集替换） */
    this._derivedIds = new Set();

    /**
     * 对外提醒账本：完全由事件流重放派生，每次投影整体重算。
     * 任何输入序列（含乱序、重复、离线补录）得到的最终账本一致；
     * 渠道侧投递请以 content_key 去重，居民端只展示 status=current 的一条。
     */
    this.notifications = [];
  }

  // ---------------------------------------------------------------- 接收

  /**
   * 接收一条事件。重复 event_id 或 idempotency_key 判定为重复投递并忽略。
   * @returns {{status: 'accepted'|'duplicate'|'invalid', event_id: string, errors?: string[]}}
   */
  ingest(event) {
    const errors = validateEvent(event);
    if (errors.length > 0) return { status: "invalid", event_id: event?.event_id ?? "", errors };

    if (this.events.has(event.event_id)) {
      return { status: "duplicate", event_id: event.event_id };
    }
    if (event.idempotency_key && this.idempotency.has(event.idempotency_key)) {
      return { status: "duplicate", event_id: this.idempotency.get(event.idempotency_key) };
    }

    this.events.set(event.event_id, event);
    if (event.idempotency_key) this.idempotency.set(event.idempotency_key, event.event_id);

    switch (event.event_type) {
      case "RULE_VETTED":
        this._applyVetting(event);
        break;
      case "EXPOSURE_REPORTED":
        this._attachExposure(event);
        this._drainInbox(event);
        break;
      case "OBSERVATION_ADDED":
        this._attachObservation(event);
        break;
      case "TREATMENT_RECORDED":
        this._attachByCaseId(event, event.payload.case_id, "treatments");
        break;
      case "LINKAGE_PROPOSED":
        this.proposals.set(event.payload.proposal_id, { ...event.payload });
        break;
      case "LINKAGE_RESOLVED":
        this._resolveLinkage(event);
        break;
      case "GUIDANCE_ISSUED":
        // 允许外部分诊台留存其指引，但不参与本引擎的当前指引投影。
        this._attachByCaseId(event, event.payload.case_id, "externalGuidance");
        break;
      case "CLUSTER_ALERTED":
      case "CASE_ESCALATED":
        // 这两类由本引擎派生；外部同 id 重放时幂等忽略即可。
        break;
      default:
        break;
    }

    this._rebuildProjections();
    return { status: "accepted", event_id: event.event_id };
  }

  /** 批量接收：先按发生时间归序，保证乱序投递的最终状态一致。 */
  ingestBatch(events) {
    const sorted = [...events].sort(byOccurred);
    const results = [];
    for (const e of sorted) results.push(this.ingest(e));
    return results;
  }

  // ---------------------------------------------------------------- 归并

  _newCase(caseId, event) {
    const c = {
      case_id: caseId,
      status: "active",
      merged_into: null,
      exposures: [],
      observations: [],
      treatments: [],
      externalGuidance: [],
      tokens: new Set(),
      patient_refs: new Set(),
      created_from: event.event_id,
    };
    this.cases.set(caseId, c);
    return c;
  }

  _applyVetting(event) {
    const { rule_id, version, vetted_at, vetted_by } = event.payload;
    const prev = this.vettings.get(rule_id);
    // 只接受不低于当前版本的审核；同版本记录审核时间。
    if (!prev || version >= prev.version) {
      this.vettings.set(rule_id, { version, vetted_at, vetted_by });
    }
  }

  _seedKey(patientRef, contactIso, locationId) {
    // 强关联键要求接触时刻完全一致：不同渠道复述同一次暴露时，
    // 患者、时刻、地点三者相同才自动归并；时刻不同只可“提案”，不武断合并。
    return `${patientRef}|${contactIso}|${locationId}`;
  }

  /** 患者稳定假名可随关联线索给在顶层，也可在 patient 画像内。 */
  _refOf(payload) {
    return payload?.patient_ref ?? payload?.patient?.patient_ref ?? null;
  }

  /** 按病例号取活跃病例对象，兼容旧号别名与已合并号。 */
  _caseById(id) {
    const canonical = this.caseAliases.get(id) ?? id;
    const c = this.cases.get(canonical);
    if (!c) return null;
    return c.status === "merged" ? this.cases.get(c.merged_into) : c;
  }

  _registerHints(c, hints = {}) {
    if (hints.case_id && hints.case_id !== c.case_id && !this.caseAliases.has(hints.case_id)) {
      // 权威病例号出现：以它为准改名登记，旧号保留为别名，不新建病例。
      // 若 hints.case_id 本身就是已知旧号别名，则无需也不得再改名。
      const oldId = c.case_id;
      this.cases.delete(oldId);
      this.caseAliases.set(oldId, hints.case_id);
      c.case_id = hints.case_id;
      this.cases.set(hints.case_id, c);
      // 已登记的令牌与强键改指新号。
      for (const t of c.tokens) this.tokenIndex.set(t, c.case_id);
      for (const [key, id] of this.seedIndex) if (id === oldId) this.seedIndex.set(key, c.case_id);
    }
    for (const t of hints.link_tokens ?? []) {
      c.tokens.add(t);
      this.tokenIndex.set(t, c.case_id);
    }
    if (hints.patient_ref || hints.patient?.patient_ref) {
      const ref = this._refOf(hints);
      c.patient_refs.add(ref);
      if (!this.patientIndex.has(ref)) this.patientIndex.set(ref, new Set());
      this.patientIndex.get(ref).add(c.case_id);
    }
  }

  _attachExposure(event) {
    const p = event.payload;
    const contactIso = p.contact.occurred_at;

    // 1) 显式病例号最权威（兼容旧号别名与已合并号）。
    if (p.case_id) {
      const resolved = this._caseById(p.case_id);
      if (resolved) {
        resolved.exposures.push(event);
        this._registerHints(resolved, p);
        this._indexSeed(resolved, p, contactIso);
        return;
      }
    }

    // 2) 跨渠道令牌。
    const tokenHits = new Set(
      (p.link_tokens ?? []).map((t) => this.tokenIndex.get(t)).filter(Boolean),
    );
    if (tokenHits.size === 1) {
      const c = this._caseById([...tokenHits][0]);
      if (c) {
        c.exposures.push(event);
        this._registerHints(c, p);
        this._indexSeed(c, p, contactIso);
        return;
      }
    }

    // 3) 强关联键：患者稳定假名 + 接触日期 + 地点。
    const ref3 = this._refOf(p);
    if (ref3) {
      const key = this._seedKey(ref3, contactIso, p.contact.location.location_id);
      const hit = this.seedIndex.get(key);
      if (hit && this.cases.has(hit) && this.cases.get(hit).status === "active") {
        const c = this.cases.get(hit);
        c.exposures.push(event);
        this._registerHints(c, p);
        return;
      }
    }

    // 4) 证据不足：建立独立病例；若同患者在同地点近似窗口另有暴露，只“提议”归并，不自动合并。
    const caseId = p.case_id ?? this._mintCaseId(event);
    const c = this._newCase(caseId, event);
    c.exposures.push(event);
    this._registerHints(c, p);
    this._indexSeed(c, p, contactIso);

    if (this._refOf(p)) this._maybeProposeNearby(c, p, contactIso);
  }

  _indexSeed(c, p, contactIso) {
    const ref = this._refOf(p);
    if (!ref) return;
    const key = this._seedKey(ref, contactIso, p.contact.location.location_id);
    // 强键只指向唯一活跃病例；若已指向别处（理论上不应发生），不覆盖以免武断合并。
    if (!this.seedIndex.has(key)) this.seedIndex.set(key, c.case_id);
  }

  _mintCaseId(event) {
    return `case-${shortHash(event.event_id)}`;
  }

  _maybeProposeNearby(c, p, contactIso) {
    const ref = this._refOf(p);
    const siblings = [...(this.patientIndex.get(ref) ?? [])]
      .map((id) => this.cases.get(id))
      .filter((other) => other && other !== c && other.status === "active");

    for (const other of siblings) {
      const otherExposure = other.exposures
        .map((e) => e.payload.contact.occurred_at)
        .sort()
        .find((t) => Math.abs(Date.parse(t) - Date.parse(contactIso)) <= this.nearbyWindowMs);
      const sameLocation = other.exposures.some(
        (e) => e.payload.contact.location.location_id === p.contact.location.location_id,
      );
      if (otherExposure && sameLocation) {
        const proposalId = `proposal-${shortHash(other.case_id + "|" + c.case_id)}`;
        if (!this.proposals.has(proposalId)) {
          this.proposals.set(proposalId, {
            proposal_id: proposalId,
            candidate_seed_keys: [other.case_id, c.case_id],
            reason: `同一患者假名 ${ref} 在同地点相近时间存在两条独立暴露登记，需人工确认是否同一次暴露`,
            status: "pending",
          });
        }
      }
    }
  }

  _attachObservation(event) {
    const p = event.payload;
    const resolved = this._resolveCaseFromHints(p, Date.parse(p.observed_at));
    if (resolved) {
      this.cases.get(resolved).observations.push(event);
      return;
    }
    // 无法判定归属（如患者有多起暴露且未带病例号）：挂起等待后续线索，绝不随机并入。
    const key = this._refOf(p) ?? `anon:${event.event_id}`;
    if (!this.observationInbox.has(key)) this.observationInbox.set(key, []);
    this.observationInbox.get(key).push(event);
  }

  _resolveCaseFromHints(hints, observedMs) {
    if (hints.case_id) {
      const canonical = this.caseAliases.get(hints.case_id) ?? hints.case_id;
      if (this.cases.has(canonical)) {
        const c = this.cases.get(canonical);
        return c.status === "active" ? c.case_id : c.merged_into;
      }
    }
    const tokenHits = new Set(
      (hints.link_tokens ?? []).map((t) => this.tokenIndex.get(t)).filter(Boolean),
    );
    if (tokenHits.size === 1) {
      const id = [...tokenHits][0];
      const c = this.cases.get(id);
      return c.status === "active" ? id : c.merged_into;
    }
    const hintRef = this._refOf(hints);
    if (hintRef) {
      const ids = [...(this.patientIndex.get(hintRef) ?? [])]
        .map((id) => this.cases.get(id))
        .filter((c) => c.status === "active");
      if (ids.length === 1) return ids[0].case_id;
      if (ids.length > 1) {
        // 多起暴露：取观察时刻之前最近一次接触的病例；仍无法区分时返回空（挂起）。
        const withPriorContact = ids
          .map((c) => ({
            c,
            t: Math.max(
              ...c.exposures.map((e) => Date.parse(e.payload.contact.occurred_at)),
            ),
          }))
          .filter((x) => Number.isFinite(x.t) && x.t <= observedMs)
          .sort((a, b) => b.t - a.t);
        if (withPriorContact.length === 1 || withPriorContact[0]?.t !== withPriorContact[1]?.t) {
          return withPriorContact[0].c.case_id;
        }
      }
    }
    return null;
  }

  _attachByCaseId(event, caseId, bucket) {
    const c = this.cases.get(caseId);
    if (!c) {
      // 病例缺失（机构消息先到）：挂到以病例号建立的占位病例，等待暴露事件补齐。
      const placeholder = this._newCase(caseId, event);
      placeholder[bucket].push(event);
      return;
    }
    const target = c.status === "merged" ? this.cases.get(c.merged_into) : c;
    target[bucket].push(event);
  }

  _drainInbox(exposureEvent) {
    const ref = this._refOf(exposureEvent.payload);
    if (!ref) return;
    const pending = this.observationInbox.get(ref);
    if (!pending || pending.length === 0) return;
    const remaining = [];
    for (const obs of pending) {
      const id = this._resolveCaseFromHints(obs.payload, Date.parse(obs.payload.observed_at));
      if (id) this.cases.get(id).observations.push(obs);
      else remaining.push(obs);
    }
    if (remaining.length > 0) this.observationInbox.set(ref, remaining);
    else this.observationInbox.delete(ref);
  }

  _resolveLinkage(event) {
    const { proposal_id, decision, case_id, resolved_at } = event.payload;
    const proposal = this.proposals.get(proposal_id);
    if (!proposal) return;
    if (decision !== "merge") {
      proposal.status = "rejected";
      proposal.resolved_at = resolved_at;
      return;
    }
    proposal.status = "merged";
    proposal.resolved_at = resolved_at;
    const [targetId, sourceId] =
      case_id === proposal.candidate_seed_keys[0]
        ? [proposal.candidate_seed_keys[0], proposal.candidate_seed_keys[1]]
        : [proposal.candidate_seed_keys[1], proposal.candidate_seed_keys[0]];
    this._mergeCases(sourceId, targetId ?? case_id);
  }

  _mergeCases(sourceId, targetId) {
    if (sourceId === targetId) return;
    const source = this.cases.get(sourceId);
    const target = this.cases.get(targetId);
    if (!source || !target) return;
    target.exposures.push(...source.exposures);
    target.observations.push(...source.observations);
    target.treatments.push(...source.treatments);
    target.externalGuidance.push(...source.externalGuidance);
    for (const t of source.tokens) {
      target.tokens.add(t);
      this.tokenIndex.set(t, targetId);
    }
    for (const ref of source.patient_refs) {
      target.patient_refs.add(ref);
      const set = this.patientIndex.get(ref);
      set?.delete(sourceId);
      set?.add(targetId);
    }
    for (const [key, id] of this.seedIndex) {
      if (id === sourceId) this.seedIndex.set(key, targetId);
    }
    source.status = "merged";
    source.merged_into = targetId;

    // 合并可能让此前无法区分归属的挂起观察变得可判定，重新归位一次。
    for (const ref of target.patient_refs) {
      const pending = this.observationInbox.get(ref);
      if (!pending || pending.length === 0) continue;
      const remaining = [];
      for (const obs of pending) {
        const id = this._resolveCaseFromHints(obs.payload, Date.parse(obs.payload.observed_at));
        if (id) this.cases.get(id).observations.push(obs);
        else remaining.push(obs);
      }
      if (remaining.length > 0) this.observationInbox.set(ref, remaining);
      else this.observationInbox.delete(ref);
    }
  }

  // ---------------------------------------------------------------- 病史快照

  /** 事件进入病史的临床时间：观察取 observed_at，其余取事件 occurred_at。 */
  _clinicalTime(event) {
    if (event.event_type === "OBSERVATION_ADDED") {
      return Date.parse(event.payload.observed_at ?? event.occurred_at);
    }
    return Date.parse(event.occurred_at);
  }

  /**
   * 构造病例截至 untilMs 的病史快照。
   * 观察更正（revises_observation_id）：在该时刻，后继观察取代被更正的旧观察。
   */
  _snapshot(c, untilMs) {
    const exposures = c.exposures
      .filter((e) => Date.parse(e.occurred_at) <= untilMs)
      .sort(byOccurred);

    const patient = {};
    for (const e of exposures) {
      Object.assign(patient, e.payload.patient ?? {});
    }
    const firstContact = exposures
      .map((e) => e.payload.contact)
      .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at))[0];

    const obsEvents = c.observations
      .filter((e) => Date.parse(e.payload.observed_at ?? e.occurred_at) <= untilMs)
      .sort((a, b) => Date.parse(a.payload.observed_at ?? a.occurred_at) - Date.parse(b.payload.observed_at ?? b.occurred_at));
    const revised = new Set();
    for (const e of obsEvents) {
      const r = e.payload.revises_observation_id;
      if (r) revised.add(r);
    }
    const effective = obsEvents.filter((e) => !revised.has(e.event_id));

    const findings = new Map();
    const measures = new Map();
    let evolution = null;
    let image = null;
    for (const e of effective) {
      for (const f of e.payload.findings ?? []) {
        const prev = findings.get(f.code);
        findings.set(f.code, prev ? { ...prev, ...f } : f);
      }
      for (const m of e.payload.measures ?? []) {
        measures.set(m.code, m.at ? m : { ...m, at: e.payload.observed_at });
      }
      if (e.payload.evolution) evolution = e.payload.evolution;
      if (e.payload.image) image = e.payload.image;
    }
    for (const e of exposures) {
      if (e.payload.image && (!image || Date.parse(e.payload.image.granted_at) > Date.parse(image.granted_at))) {
        image = e.payload.image;
      }
    }

    const treatments = c.treatments
      .filter((e) => Date.parse(e.payload.treated_at) <= untilMs)
      .sort((a, b) => Date.parse(a.payload.treated_at) - Date.parse(b.payload.treated_at));

    return { patient, contact: firstContact ?? null, findings, measures: [...measures.values()], evolution, image, treatments };
  }

  // ---------------------------------------------------------------- 分诊投影
  //
  // GUIDANCE_ISSUED / CASE_ESCALATED / CLUSTER_ALERTED 与 notifications 都是
  // 可由源事件完整重建的投影：每次接收后整体重算，因此重复投递、乱序到达、
  // 离线补录、人工合并后的最终结果必然一致，不会并存两条互相冲突的当前提醒。
  // 历史可追溯性由派生事件之间的 supersedes_event_ids 链保证；源事件本身只追加。

  _rebuildProjections() {
    const desired = [];

    for (const c of this.cases.values()) {
      if (status_active(c)) {
        const { guidance, escalations } = this._projectCase(c);
        c.derivedGuidance = guidance;
        c.derivedEscalations = escalations;
        c.escalated = escalations.length > 0;
        desired.push(...guidance, ...escalations);
      } else {
        c.derivedGuidance = [];
        c.derivedEscalations = [];
      }
    }

    const alerts = this._computeAlerts();
    desired.push(...alerts);

    // 用上一批派生事件集合做差集替换：源事件永不删除，只替换派生投影。
    for (const id of this._derivedIds ?? []) {
      if (!desired.some((e) => e.event_id === id)) this.events.delete(id);
    }
    this._derivedIds = new Set(desired.map((e) => e.event_id));
    for (const e of desired) this.events.set(e.event_id, e);

    this._rebuildNotifications(alerts);
  }

  _projectCase(c) {
    const timeline = [];
    for (const e of c.exposures) timeline.push({ t: this._clinicalTime(e), event: e });
    for (const e of c.observations) timeline.push({ t: this._clinicalTime(e), event: e });
    for (const e of c.treatments) timeline.push({ t: this._clinicalTime(e), event: e });
    timeline.sort((a, b) => a.t - b.t || TYPE_ORDER[a.event_type] - TYPE_ORDER[b.event_type]);

    const guidance = [];
    const escalations = [];
    let prevGuidanceId = null;
    let prevEscalated = false;

    for (const point of timeline) {
      const snap = this._snapshot(c, point.t);
      const asOfIso =
        point.event.event_type === "OBSERVATION_ADDED"
          ? point.event.payload.observed_at
          : point.event.occurred_at;
      const result = evaluateTriage(snap, asOfIso, this.vettings);
      const floor = this._clinicalFloor(snap.treatments);
      const triggered = result?.triggered_items ?? [];

      // 没有任何生效审核规则命中时不产出建议：在医处置只能“抬高”已有建议，
      // 不能在无规则依据时凭空生成建议（建议必须可追溯到经审核的规则）。
      if (!result) {
        prevEscalated = false;
        continue;
      }

      let level = result.level;
      if (floor && LEVEL_RANK[level] < LEVEL_RANK.seek_care) {
        level = "seek_care";
      }
      const escalatesNow = Boolean(triggered.some((x) => x.escalates) || floor);

      const actions = [...result.actions];
      if (floor) actions.push("该病例已有医疗机构接诊处置，请遵医嘱；若尚未在院请立即前往急诊");
      const { title } = result;
      const ruleVersions = result.rule_versions;
      const basis = JSON.stringify({
        level,
        triggered: triggered.map((x) => `${x.rule_id}@v${x.rule_version}:${x.reason_code}`),
        floor: floor ?? "none",
      });
      const guideId = `guidance-${c.case_id}-${point.event.event_id}-${shortHash(basis)}`;

      guidance.push({
        event_id: guideId,
        event_type: "GUIDANCE_ISSUED",
        aggregate_type: "exposure_case",
        aggregate_id: c.case_id,
        occurred_at: asOfIso,
        version: 1,
        summary: `自动分诊建议：${title}`,
        payload: {
          case_id: c.case_id,
          level,
          title,
          actions,
          triggered_items: triggered,
          rule_versions: ruleVersions,
          as_of: asOfIso,
          because_event_id: point.event.event_id,
          disclaimer: DISCLAIMER,
          clinical_care_in_progress: Boolean(floor),
          ...(prevGuidanceId ? { supersedes_event_ids: [prevGuidanceId] } : {}),
        },
      });

      // 升级只在“从非升级变为升级”的边沿发出一次；症状被新观察推翻后再次恶化，
      // 才产生新的升级事件，而不是在每个严重观察点重复升级。
      if (escalatesNow && !prevEscalated) {
        const reasons = triggered
          .filter((x) => x.escalates)
          .map((x) => x.detail);
        if (floor) reasons.push(`医疗机构已接诊处置（${floor}），自动建议不再下调`);
        escalations.push({
          event_id: `escalation-${c.case_id}-${point.event.event_id}`,
          event_type: "CASE_ESCALATED",
          aggregate_type: "exposure_case",
          aggregate_id: c.case_id,
          occurred_at: asOfIso,
          version: 1,
          summary: "出现需医生评估的表现，病例升级",
          payload: {
            case_id: c.case_id,
            reasons,
            because_event_id: point.event.event_id,
            escalated_at: asOfIso,
          },
        });
      }
      prevGuidanceId = guideId;
      prevEscalated = escalatesNow;
    }

    return { guidance, escalations };
  }

  _clinicalFloor(treatments) {
    const latest = treatments[treatments.length - 1];
    if (!latest) return null;
    return ACTIVE_CARE_DISPOSITIONS.has(latest.payload.disposition) ? latest.payload.disposition : null;
  }

  /**
   * 重建对外提醒账本：
   * - 指引提醒按“连续内容变化”编号，内容不变不重复提醒；旧建议自动标 superseded；
   *   级别被新观察推翻后再返回时，是一条新的、当前有效的提醒，不会与历史冲突。
   * - 合并/撤回的病例，其既往提醒标 withdrawn，渠道侧应撤回展示。
   * - 聚集预警按“地点 + 固定时间桶 + 内容”编号，同桶内容不变只发一次。
   */
  _rebuildNotifications(alertEvents) {
    const previous = new Map(this.notifications.map((n) => [n.key, n]));
    const next = [];
    const keep = new Set();

    for (const c of this.cases.values()) {
      if (c.status !== "active") continue;
      const chain = (c.derivedGuidance ?? []).slice().sort(
        (a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at),
      );
      // 折叠相邻完全相同的内容（同一内容重复确认不应再提醒）。
      const steps = [];
      for (const g of chain) {
        const content = guidanceContent(g.payload);
        const last = steps[steps.length - 1];
        if (last && last.contentHash === content.hash) {
          last.events.push(g.event_id);
        } else {
          steps.push({ contentHash: content.hash, payload: g.payload, events: [g.event_id] });
        }
      }
      let prevKey = null;
      steps.forEach((step, i) => {
        const key = `gnotify|${c.case_id}|#${i + 1}|${step.contentHash}`;
        keep.add(key);
        const isCurrent = i === steps.length - 1;
        next.push({
          key,
          type: "GUIDANCE_ISSUED",
          case_id: c.case_id,
          level: step.payload.level,
          as_of: step.payload.as_of,
          guidance_event_ids: step.events,
          supersedes: prevKey,
          issued_at: previous.get(key)?.issued_at ?? this._now().toISOString(),
          status: isCurrent ? "current" : "superseded",
          ...(isCurrent ? {} : { superseded_by: steps[i + 1] ? `gnotify|${c.case_id}|#${i + 2}|${steps[i + 1].contentHash}` : null }),
        });
        prevKey = key;
      });
    }

    // 预警提醒：每个地点当前时间桶至多一条 current。
    const byLocation = new Map();
    for (const e of alertEvents) {
      if (!byLocation.has(e.payload.location_id)) byLocation.set(e.payload.location_id, []);
      byLocation.get(e.payload.location_id).push(e);
    }
    for (const [locationId, events] of byLocation) {
      events.sort((a, b) => Date.parse(a.payload.window_start) - Date.parse(b.payload.window_start));
      let prevKey = null;
      events.forEach((e, i) => {
        const key = `anotify|${locationId}|${e.payload.window_start}|${shortHash(
          JSON.stringify({ band: e.payload.distinct_residents_band, tags: e.payload.sign_tags }),
        )}`;
        keep.add(key);
        const isCurrent = i === events.length - 1;
        next.push({
          key,
          type: "CLUSTER_ALERTED",
          location_id: locationId,
          alert_event_id: e.event_id,
          issued_at: previous.get(key)?.issued_at ?? e.payload.issued_at,
          status: isCurrent ? "current" : "superseded",
          supersedes: prevKey,
        });
        prevKey = key;
      });
    }

    // 上轮存在、本轮消失的提醒（典型：病例被人工合并）：标记撤回，不静默丢弃。
    for (const old of previous.values()) {
      if (!keep.has(old.key)) {
        next.push({ ...old, status: "withdrawn", withdrawn_at: this._now().toISOString() });
      }
    }

    this.notifications = next;
  }

  // ---------------------------------------------------------------- 聚集预警

  /**
   * 计算固定时间桶内的地点聚集。固定桶（而非滑动窗口）保证离线补录不会
   * 因窗口滑动而不断产生新预警。只有不同居民数达到隐私阈值才出预警，
   * 预警载荷不含任何身份、原图与精确地址，人数以分箱发布。
   */
  _computeAlerts() {
    const nowMs = this._now().getTime();
    const bucketStartMs = Math.floor(nowMs / this.clusterWindowMs) * this.clusterWindowMs;
    const bucketStart = new Date(bucketStartMs).toISOString();
    const bucketEnd = new Date(bucketStartMs + this.clusterWindowMs).toISOString();

    /** location_id -> {location, residents: Map<ref, {signs:Set, agent}>} */
    const buckets = new Map();
    /** location_id -> Set<case_id> */
    const locationCases = new Map();

    for (const c of this.cases.values()) {
      if (c.status !== "active") continue;
      for (const e of c.exposures) {
        const t = Date.parse(e.payload.contact.occurred_at);
        if (t < bucketStartMs || t > nowMs) continue;
        // 只认居民稳定假名；热线坐席等上报方标识不能充当居民计数。
        const ref = this._refOf(e.payload);
        const loc = e.payload.contact.location;
        if (!locationCases.has(loc.location_id)) locationCases.set(loc.location_id, new Set());
        locationCases.get(loc.location_id).add(c.case_id);
        if (!ref) continue;
        if (!buckets.has(loc.location_id)) {
          buckets.set(loc.location_id, { location: loc, residents: new Map() });
        }
        const residents = buckets.get(loc.location_id).residents;
        if (!residents.has(ref)) residents.set(ref, { signs: new Set(), agent: null });
        if (e.payload.contact.suspected_agent) residents.get(ref).agent = e.payload.contact.suspected_agent;
      }
    }

    // 每位居民在该地点的当前有效皮损标签（只取标签，不带身份外的其他信息）。
    for (const [locationId, b] of buckets) {
      for (const ref of b.residents.keys()) {
        for (const caseId of locationCases.get(locationId) ?? []) {
          const c = this.cases.get(caseId);
          if (!c.patient_refs.has(ref)) continue;
          const snap = this._snapshot(c, nowMs);
          for (const code of snap.findings.keys()) {
            if (FINDING_TAGS[code]) b.residents.get(ref).signs.add(FINDING_TAGS[code]);
          }
        }
      }
    }

    const alerts = [];
    for (const [locationId, b] of buckets) {
      const n = b.residents.size;
      if (n < this.privacyThreshold) continue;
      const signTags = [...new Set([...b.residents.values()].flatMap((r) => [...r.signs]))].sort();
      const agents = [...new Set([...b.residents.values()].map((r) => r.agent).filter(Boolean))];
      const band = this._band(n);
      const contentHash = shortHash(`${band}|${signTags.join(",")}`);
      alerts.push({
        event_id: `alert-${locationId}-${Date.parse(bucketStart)}-${contentHash}`,
        event_type: "CLUSTER_ALERTED",
        aggregate_type: "public_alert",
        aggregate_id: `public-alert-${locationId}`,
        occurred_at: this._now().toISOString(),
        version: 1,
        summary: `${b.location.district} ${b.location.location_name} 附近隐翅虫暴露聚集提示`,
        payload: {
          location_id: locationId,
          location_name: b.location.location_name,
          district: b.location.district,
          window_start: bucketStart,
          window_end: bucketEnd,
          privacy_threshold: this.privacyThreshold,
          distinct_residents_band: band,
          sign_tags: signTags,
          ...(agents.length === 1 ? { suspected_agent: agents[0] } : {}),
          issued_at: this._now().toISOString(),
        },
      });
    }
    return alerts;
  }

  _band(n) {
    const lo = this.privacyThreshold + Math.floor((n - this.privacyThreshold) / this.bandSize) * this.bandSize;
    return `${lo}-${lo + this.bandSize - 1}`;
  }

  // ---------------------------------------------------------------- 分角色读模型

  /** 把病例号（含旧号别名、已合并号）解析为当前活跃病例对象。 */
  _resolveCase(caseId) {
    const canonical = this.caseAliases.get(caseId) ?? caseId;
    const c = this.cases.get(canonical);
    if (!c) return null;
    return c.status === "merged" ? this.cases.get(c.merged_into) : c;
  }

  /** 居民视图：每次补充症状后只看到唯一、当前有效的指引及其触发项。 */
  residentView(caseId) {
    const c = this._resolveCase(caseId);
    if (!c || c.status !== "active") return null;
    const guidance = c.derivedGuidance ?? [];
    const current = guidance[guidance.length - 1] ?? null;
    return {
      case_id: c.case_id,
      current_guidance: current
        ? {
            level: current.payload.level,
            title: current.payload.title,
            actions: current.payload.actions,
            triggered_items: current.payload.triggered_items,
            as_of: current.payload.as_of,
            disclaimer: current.payload.disclaimer,
            clinical_care_in_progress: current.payload.clinical_care_in_progress,
          }
        : null,
      history: guidance.map((g) => ({
        level: g.payload.level,
        title: g.payload.title,
        as_of: g.payload.as_of,
        because_event_id: g.payload.because_event_id,
      })),
    };
  }

  /**
   * 接诊机构视图：可接续此前经过（接触、症状演变、自行处理、其他机构处置）。
   * 图像只有在 image.consent_scope === "clinical" 时返回引用，否则只记录“有图但未授权”。
   */
  clinicianView(caseId) {
    const target = this._resolveCase(caseId);
    if (!target) return null;
    const gateImage = (image) =>
      image?.consent_scope === "clinical"
        ? { image_ref: image.image_ref, consent_scope: "clinical", granted_at: image.granted_at }
        : image
          ? { image_ref: null, consent_scope: "none", note: "居民未向临床团队开放图像" }
          : null;

    const nowMs = this._now().getTime();
    const snap = this._snapshot(target, nowMs);

    return {
      case_id: target.case_id,
      escalated: Boolean(target.escalated),
      contact: snap.contact
        ? {
            occurred_at: snap.contact.occurred_at,
            location: snap.contact.location.location_name,
            district: snap.contact.location.district,
            suspected_agent: snap.contact.suspected_agent ?? null,
          }
        : null,
      patient: {
        age_group: snap.patient.age_group ?? null,
        baseline_risks: snap.patient.baseline_risks ?? [],
      },
      timeline: [
        ...target.exposures.map((e) => ({
          at: e.occurred_at,
          kind: "exposure_reported",
          channel: e.payload.reporter.channel,
          image: gateImage(e.payload.image),
          note: e.payload.note ?? null,
        })),
        ...target.observations
          .filter((e) => !this._isRevised(target, e))
          .map((e) => ({
            at: e.payload.observed_at,
            kind: "observation_added",
            findings: (e.payload.findings ?? []).map((f) => ({
              code: f.code,
              label: FINDING_TAGS[f.code] ?? f.code,
              severity: f.severity,
              area_cm2: f.area_cm2 ?? null,
              spreading: f.spreading ?? false,
            })),
            measures: (e.payload.measures ?? []).map((m) => m.code),
            evolution: e.payload.evolution ?? null,
            image: gateImage(e.payload.image),
            note: e.payload.note ?? null,
          })),
        ...target.treatments.map((e) => ({
          at: e.payload.treated_at,
          kind: "treatment_recorded",
          institution_id: e.payload.institution_id,
          institution_name: e.payload.institution_name ?? null,
          disposition: e.payload.disposition,
          diagnosis_suspected: e.payload.diagnosis_suspected ?? null,
          actions: e.payload.actions,
        })),
      ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
      current_guidance: (() => {
        const g = target.derivedGuidance?.[target.derivedGuidance.length - 1];
        return g
          ? { level: g.payload.level, triggered_items: g.payload.triggered_items, as_of: g.payload.as_of }
          : null;
      })(),
    };
  }

  _isRevised(c, obs) {
    return c.observations.some((e) => e.payload.revises_observation_id === obs.event_id);
  }

  /** 疾控视图：只有达到隐私阈值的地点级聚集与脱敏分箱，无身份、无原图、无精确地址。 */
  cdcView() {
    const alerts = [...this.events.values()]
      .filter((e) => e.event_type === "CLUSTER_ALERTED")
      .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));
    return {
      privacy_threshold: this.privacyThreshold,
      cluster_alerts: alerts.map((e) => ({ ...e.payload })),
    };
  }

  /**
   * 数据治理队列：待人工裁决的归并提案。疾控角色不读取此队列；
   * 队列中不回传患者假名，只给候选病例号与原因类别，避免无关身份外溢。
   */
  linkageQueue() {
    return [...this.proposals.values()]
      .filter((p) => p.status === "pending")
      .map((p) => ({
        proposal_id: p.proposal_id,
        candidate_case_ids: p.candidate_seed_keys,
        reason: "同一稳定假名在同地点相近时间存在多条暴露登记，需确认是否同一次暴露",
        status: p.status,
      }));
  }
}
