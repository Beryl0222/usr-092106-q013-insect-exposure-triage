/**
 * 虫害暴露分诊协同：领域事件与读模型类型。
 *
 * 约定：
 * - 事件一经接收，event_id / occurred_at / version 不原地改写；更正产生后继记录。
 * - 归并依据显式 case_id、跨渠道 link_token 或强关联键，绝不依据同名合并患者。
 * - 自动指引只能来自 RULE_VETTED 审核记录激活的规则，且必须展示触发项、不替代医生。
 */

/** 建议级别：清洗 / 观察 / 尽快就医。 */
export type RecommendationLevel = "clean" | "observe" | "seek_care";

/** 图像授权范围：none 不授权；clinical 仅接诊临床团队可见。任何范围都不向疾控开放原图。 */
export type ImageConsentScope = "none" | "clinical";

export type FindingSeverity = "mild" | "moderate" | "severe";

/** 经临床审核认可的皮损/全身表现代码。 */
export type FindingCode =
  | "erythema" // 红斑
  | "large_erythema" // 大面积红斑
  | "blister" // 水疱
  | "pustule" // 脓疱
  | "erosion_oozing" // 糜烂渗出
  | "rapid_spread" // 快速扩展
  | "eye_involvement" // 眼周/眼部受累
  | "face_genital_involvement" // 面部/会阴受累
  | "systemic_symptom"; // 发热等全身症状

/** 患者自行采取过的处理。 */
export type MeasureCode =
  | "alcohol_applied" // 涂抹酒精
  | "iodine_applied" // 涂抹碘酒
  | "toothpaste_applied" // 涂抹牙膏等偏方
  | "rinsed_with_water" // 清水冲洗
  | "cold_compress" // 冷敷
  | "scratch_burst"; // 抓破/虫体拍压

export type Evolution = "improving" | "stable" | "worsening";

export type AgeGroup = "infant" | "child" | "adult" | "older_adult";

export type Channel = "hospital" | "community_hotline" | "resident_app" | "cdc_forward";

/** 事件信封：所有事件共有。 */
export interface DomainEvent {
  event_id: string;
  event_type:
    | "EXPOSURE_REPORTED"
    | "OBSERVATION_ADDED"
    | "GUIDANCE_ISSUED"
    | "CASE_ESCALATED"
    | "TREATMENT_RECORDED"
    | "RULE_VETTED"
    | "LINKAGE_PROPOSED"
    | "LINKAGE_RESOLVED"
    | "CLUSTER_ALERTED";
  aggregate_type:
    | "exposure_case"
    | "triage_rule"
    | "exposure_linkage"
    | "public_alert";
  aggregate_id: string;
  /** 事件实际发生时间（离线补录允许早于接收时间）。 */
  occurred_at: string;
  version: number;
  summary: string;
  /** 上报方去重键：同一渠道同一原始记录重复投递时幂等。 */
  idempotency_key?: string;
  /** 该记录更正/撤销的既往事件。 */
  correction_of_event_id?: string;
  payload?: Record<string, unknown>;
}

/** 跨渠道归并线索：病例自身标识与显式关联令牌。 */
export interface LinkageHints {
  /** 已分配的病例号；出现即权威。 */
  case_id?: string;
  /** 跨渠道流转令牌（热线工单号、回执码、二维码等）。 */
  link_tokens?: string[];
  /** 强关联键所需的患者稳定假名（非姓名）。 */
  patient_ref?: string;
}

export interface ExposureLocation {
  /** 场所/网格稳定标识，用于聚集计算。 */
  location_id: string;
  location_name: string;
  district: string;
  /** 粗略点位，仅临床需要时使用，不进入公共预警。 */
  address?: string;
}

export interface ImageAttachment {
  /** 图像存储指针，事件中不含原图。 */
  image_ref: string;
  consent_scope: ImageConsentScope;
  granted_at: string;
}

export interface PatientProfile {
  /** 稳定患者假名；同名不同人必须不同。 */
  patient_ref?: string;
  display_name?: string;
  age_group?: AgeGroup;
  /** 基础风险：孕哺、免疫抑制、严重过敏史等。 */
  baseline_risks?: string[];
}

export interface ExposureReportedPayload extends LinkageHints {
  reporter: {
    channel: Channel;
    reporter_ref?: string;
  };
  source_record_id?: string;
  patient?: PatientProfile;
  contact: {
    occurred_at: string;
    location: ExposureLocation;
    suspected_agent?: string;
  };
  image?: ImageAttachment;
  note?: string;
}

export interface Finding {
  code: FindingCode;
  severity: FindingSeverity;
  area_cm2?: number;
  /** 是否仍在向外扩展。 */
  spreading?: boolean;
  observed_since?: string;
}

export interface TakenMeasure {
  code: MeasureCode;
  at?: string;
}

export interface ObservationAddedPayload extends LinkageHints {
  observed_at: string;
  findings?: Finding[];
  measures?: TakenMeasure[];
  evolution?: Evolution;
  image?: ImageAttachment;
  note?: string;
  /** 更正既往某条观察（后继记录，不删改原事件）。 */
  revises_observation_id?: string;
}

export interface TriggeredItem {
  rule_id: string;
  rule_version: number;
  reason_code: string;
  /** 命中该规则的具体观察事实，供居民与医生核对。 */
  detail: string;
  escalates: boolean;
}

export interface GuidanceIssuedPayload {
  case_id: string;
  level: RecommendationLevel;
  title: string;
  actions: string[];
  triggered_items: TriggeredItem[];
  /** 参与评估的审核规则版本，保证建议可追溯。 */
  rule_versions: string[];
  /** 建议对应的临床时间点（观察事件 occurred_at）。 */
  as_of: string;
  because_event_id: string;
  disclaimer: string;
  /** 已被本条建议取代的既往 GUIDANCE_ISSUED 事件。 */
  supersedes_event_ids?: string[];
  /** 已有急诊/住院处置时，自动建议不得下调到此以下。 */
  clinical_care_in_progress?: boolean;
}

export interface CaseEscalatedPayload {
  case_id: string;
  reasons: string[];
  because_event_id: string;
  escalated_at: string;
}

export type TreatmentDisposition =
  | "treated_discharged"
  | "referred_urgent"
  | "admitted"
  | "resolved";

export interface TreatmentRecordedPayload {
  case_id: string;
  institution_id: string;
  institution_name?: string;
  treated_at: string;
  disposition: TreatmentDisposition;
  diagnosis_suspected?: string;
  actions: string[];
  note?: string;
}

export interface RuleDefinition {
  rule_id: string;
  version: number;
  level: RecommendationLevel;
  escalates: boolean;
  reason_code: string;
  title: string;
  actions: string[];
}

export interface RuleVettedPayload {
  rule_id: string;
  version: number;
  vetted_by: string;
  vetted_at: string;
}

export interface LinkageProposedPayload {
  proposal_id: string;
  candidate_seed_keys: string[];
  reason: string;
  status: "pending";
}

export interface LinkageResolvedPayload {
  proposal_id: string;
  decision: "merge" | "reject";
  /** merge 时并入的目标病例。 */
  case_id?: string;
  resolved_by: string;
  resolved_at: string;
}

export interface ClusterAlertedPayload {
  location_id: string;
  location_name: string;
  district: string;
  window_start: string;
  window_end: string;
  /** 发布前必须达到的不同居民数隐私阈值。 */
  privacy_threshold: number;
  /** 脱敏计数区间，而非精确人数。 */
  distinct_residents_band: string;
  sign_tags: string[];
  suspected_agent?: string;
  issued_at: string;
}
