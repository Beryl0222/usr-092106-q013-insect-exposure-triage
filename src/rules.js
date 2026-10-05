/**
 * 经审核的分诊规则库与评估逻辑（纯函数）。
 *
 * 规则只有在收到对应 rule_id + version 的 RULE_VETTED 审核事件后才生效；
 * 且评估某一时刻的观察时，只采用该时刻之前已审核的版本，不追溯改写历史建议。
 * 所有建议都必须回传触发项，且带有“不能替代医生”的声明。
 */

export const LEVEL_RANK = Object.freeze({ clean: 0, observe: 1, seek_care: 2 });

export const DISCLAIMER =
  "本建议由经审核的分诊规则自动生成，仅用于即时处置参考，不能替代医生面诊与诊断；如症状加重请立即就医。";

/** 判定为需要升级的严重表现代码（大面积红斑、水疱、脓疱、糜烂渗出、快速扩展等）。 */
const SEVERE_CODES = new Set([
  "large_erythema",
  "blister",
  "pustule",
  "erosion_oozing",
  "rapid_spread",
]);

const SENSITIVE_SITE_CODES = new Set(["eye_involvement", "face_genital_involvement"]);

const HARMFUL_MEASURES = new Set([
  "alcohol_applied",
  "iodine_applied",
  "toothpaste_applied",
  "scratch_burst",
]);

/** 红斑面积达到“大面积”的阈值（平方厘米）。 */
export const LARGE_AREA_CM2 = 100;
/** 接触后多久内仍给出“冲洗去污”基础建议。 */
export const CONTACT_WINDOW_MS = 72 * 60 * 60 * 1000;

const FINDING_LABELS = Object.freeze({
  erythema: "红斑",
  large_erythema: "大面积红斑",
  blister: "水疱",
  pustule: "脓疱",
  erosion_oozing: "糜烂渗出",
  rapid_spread: "快速扩展",
  eye_involvement: "眼周/眼部受累",
  face_genital_involvement: "面部/会阴受累",
  systemic_symptom: "发热等全身症状",
});

const MEASURE_LABELS = Object.freeze({
  alcohol_applied: "涂抹酒精",
  iodine_applied: "涂抹碘酒",
  toothpaste_applied: "涂抹牙膏等偏方",
  rinsed_with_water: "清水冲洗",
  cold_compress: "冷敷",
  scratch_burst: "抓破或拍压虫体",
});

const RULES = [
  {
    rule_id: "R-CONTACT-CLEAN",
    version: 1,
    level: "clean",
    escalates: false,
    reason_code: "contact_no_sign_yet",
    title: "立即冲洗去污，避免刺激",
    actions: [
      "用流动清水或肥皂水轻柔冲洗接触部位至少 10 分钟，不要搓揉或拍压",
      "不要涂抹酒精、碘酒、牙膏、酱油等刺激性物品",
      "更换并单独清洗沾染衣物，避免虫体毒液继续接触皮肤",
      "记录接触时间与地点，后续拍照在同一距离、同一光线下对比",
    ],
    match(snapshot, asOfMs) {
      if (snapshot.findings.size > 0) return null;
      const contactMs = snapshot.contact ? Date.parse(snapshot.contact.occurred_at) : NaN;
      if (!Number.isFinite(contactMs) || asOfMs - contactMs > CONTACT_WINDOW_MS) return null;
      return "接触发生在 72 小时内，暂未记录皮损表现";
    },
  },
  {
    rule_id: "R-HARMFUL-MEASURE",
    version: 1,
    level: "observe",
    escalates: false,
    reason_code: "harmful_self_measure",
    title: "停止刺激性处理，继续观察",
    actions: [
      "立即停止涂抹酒精/碘酒/牙膏等刺激物，改用清水轻柔冲洗",
      "保持创面清洁干燥，不要主动挑破水疱",
      "若红斑范围扩大或出现水疱、渗液，尽快就医",
    ],
    match(snapshot) {
      const hit = snapshot.measures.filter((m) => HARMFUL_MEASURES.has(m.code));
      if (hit.length === 0) return null;
      return `已采取刺激性处理：${hit.map((m) => MEASURE_LABELS[m.code]).join("、")}`;
    },
  },
  {
    rule_id: "R-MILD-LOCAL-SIGN",
    version: 1,
    level: "observe",
    escalates: false,
    reason_code: "mild_local_erythema",
    title: "局部轻症，居家观察",
    actions: [
      "清水冲洗后保持干燥，可冷敷缓解，不要搔抓或挑破",
      "未来 24–48 小时观察红斑范围、颜色与是否出现水疱",
      "如明显扩大、起疱、渗液或累及眼面/会阴，尽快就医",
    ],
    match(snapshot) {
      const erythema = snapshot.findings.get("erythema");
      if (!erythema) return null;
      for (const code of [...SEVERE_CODES, ...SENSITIVE_SITE_CODES]) {
        if (snapshot.findings.has(code)) return null;
      }
      if ((erythema.area_cm2 ?? 0) >= LARGE_AREA_CM2 || erythema.spreading) return null;
      if (snapshot.evolution === "worsening") return null;
      return `局部小片红斑（约 ${erythema.area_cm2 ?? "未估"} 平方厘米），无扩大趋势`;
    },
  },
  {
    rule_id: "R-WORSENING-TREND",
    version: 1,
    level: "observe",
    escalates: false,
    reason_code: "worsening_trend",
    title: "症状在进展，加密观察并随诊",
    actions: [
      "每 4–6 小时在同一距离拍照对比，记录红斑边界变化",
      "停止一切刺激性自行处理，清水冲洗、保持干燥",
      "若继续扩大、出现水疱/脓疱/渗液或发热，立即就医",
    ],
    match(snapshot) {
      for (const code of [...SEVERE_CODES, ...SENSITIVE_SITE_CODES]) {
        if (snapshot.findings.has(code)) return null;
      }
      const spreading = [...snapshot.findings.values()].some((f) => f.spreading);
      if (snapshot.evolution !== "worsening" && !spreading) return null;
      return "最新随访显示皮损仍在扩大/症状加重，尚未记录严重表现";
    },
  },
  {
    rule_id: "R-SEVERE-SIGN",
    version: 1,
    level: "seek_care",
    escalates: true,
    reason_code: "severe_skin_sign",
    title: "出现严重皮损，尽快就医",
    actions: [
      "请尽快前往最近医院急诊或皮肤科，不要自行挑破水疱或涂抹刺激物",
      "就医时携带接触经过、既往照片与已使用物品清单",
      "途中清水冲洗后以清洁敷料覆盖，避免摩擦",
    ],
    match(snapshot) {
      const hit = [...SEVERE_CODES].filter((code) => snapshot.findings.has(code));
      const erythema = snapshot.findings.get("erythema");
      if (erythema && (erythema.area_cm2 ?? 0) >= LARGE_AREA_CM2 && !hit.includes("large_erythema")) {
        hit.push("large_erythema");
      }
      if (hit.length === 0) return null;
      return `已记录需要医生评估的表现：${hit.map((c) => FINDING_LABELS[c]).join("、")}`;
    },
  },
  {
    rule_id: "R-SENSITIVE-SITE",
    version: 1,
    level: "seek_care",
    escalates: true,
    reason_code: "sensitive_site_involvement",
    title: "眼面/会阴等敏感部位受累，尽快就医",
    actions: [
      "眼部接触立即用清水持续冲洗至少 15 分钟并前往急诊",
      "不要在眼面、会阴部位自行涂药",
    ],
    match(snapshot) {
      const hit = [...SENSITIVE_SITE_CODES].filter((code) => snapshot.findings.has(code));
      if (hit.length === 0) return null;
      return `敏感部位受累：${hit.map((c) => FINDING_LABELS[c]).join("、")}`;
    },
  },
  {
    rule_id: "R-VULNERABLE-SYSTEMIC",
    version: 1,
    level: "seek_care",
    escalates: true,
    reason_code: "systemic_or_vulnerable",
    title: "全身症状或脆弱人群加重，尽快就医",
    actions: [
      "出现发热、头晕等全身症状，或婴幼儿/老人/免疫低下者皮损加重，请尽快就医",
      "就诊时告知基础疾病、过敏史与已采取的处理",
    ],
    match(snapshot) {
      if (snapshot.findings.has("systemic_symptom")) return FINDING_LABELS.systemic_symptom;
      const vulnerable =
        snapshot.patient.age_group === "infant" ||
        snapshot.patient.age_group === "older_adult" ||
        (snapshot.patient.baseline_risks || []).includes("immunocompromised");
      if (vulnerable && snapshot.evolution === "worsening") {
        return "脆弱人群（婴幼儿/老人/免疫低下）症状在加重";
      }
      return null;
    },
  },
];

export const RULE_REGISTRY = Object.freeze(RULES);

/**
 * 生成对一批规则进行临床审核的 RULE_VETTED 种子事件。
 * 生产环境 vetted_by 必须是真实审核责任人，此处仅作初始化便利方法。
 */
export function vettingEvents(ruleIds, { vetted_by, vetted_at }) {
  return ruleIds.map((rule_id, i) => ({
    event_id: `vetting-${rule_id}-v1`,
    event_type: "RULE_VETTED",
    aggregate_type: "triage_rule",
    aggregate_id: rule_id,
    occurred_at: vetted_at,
    version: 1,
    summary: `${vetted_by} 审核启用分诊规则 ${rule_id} v1`,
    payload: { rule_id, version: 1, vetted_by, vetted_at: new Date(Date.parse(vetted_at) + i).toISOString() },
  }));
}

/** 截至 asOf 已生效（已审核且审核时间不晚于该时刻）的规则。 */
export function activeRules(vettings, asOfMs) {
  const active = [];
  for (const rule of RULE_REGISTRY) {
    const v = vettings.get(rule.rule_id);
    if (v && v.version === rule.version && Date.parse(v.vetted_at) <= asOfMs) active.push(rule);
  }
  return active;
}

/**
 * 依据当前病例快照评估分诊建议。
 * @returns {{level: string, title: string, actions: string[], triggered_items: Array, rule_versions: string[]}|null}
 */
export function evaluateTriage(snapshot, asOfIso, vettings) {
  const asOfMs = Date.parse(asOfIso);
  const rules = activeRules(vettings, asOfMs);
  const triggered = [];
  let topLevel = null;

  for (const rule of rules) {
    const detail = rule.match(snapshot, asOfMs);
    if (detail === null || detail === undefined) continue;
    triggered.push({
      rule_id: rule.rule_id,
      rule_version: rule.version,
      reason_code: rule.reason_code,
      detail,
      escalates: rule.escalates,
    });
    if (topLevel === null || LEVEL_RANK[rule.level] > LEVEL_RANK[topLevel]) topLevel = rule.level;
  }

  if (triggered.length === 0) return null;

  const topRules = rules.filter(
    (r) => triggered.some((t) => t.rule_id === r.rule_id) && r.level === topLevel,
  );
  const title = topRules[0].title;
  const actions = [
    ...new Set(rules.flatMap((r) => (triggered.some((t) => t.rule_id === r.rule_id) ? r.actions : []))),
  ];

  return {
    level: topLevel,
    title,
    actions,
    triggered_items: triggered,
    rule_versions: triggered.map((t) => `${t.rule_id}@v${t.rule_version}`),
  };
}
