/*
 * 胶片抢救任务指挥台 —— 核心逻辑层（无 DOM 依赖）
 * 对外暴露 window.FilmRescue：
 *   createStore()  事务/持久化/撤销重做/离线合并
 *   领域规则助手（资源冲突、库存预留、流转校验、三方合并）
 */
(function () {
  "use strict";

  const APP_KEY = "zfl17-film-rescue-desk-v2";
  const UI_KEY = "zfl17-film-rescue-desk-ui";
  const OLD_APP_KEY = "zfl17-film-strip-desk";
  const UNDO_LIMIT = 30;

  // ---------- 基础工具 ----------
  function uid(prefix) {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }

  function clone(value) {
    return structuredClone(value);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // 53 位字符串哈希，用于证据内容去重（完全重复只吸收一次）
  function hashContent(str) {
    const text = String(str ?? "");
    let h1 = 0xdeadbeef ^ text.length;
    let h2 = 0x41c6ce57 ^ text.length;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }

  class AppError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  // ---------- 常量 ----------
  const STATUS = {
    registered: "登记",
    dispatched: "派工",
    repairing: "修复",
    reviewing: "复检",
    approved: "待关闭",
    closed: "关闭"
  };
  const KANBAN_COLS = ["registered", "dispatched", "repairing", "reviewing", "closed"];
  // approved（复检通过待关闭）卡片归入“复检”列
  const SEVERITIES = ["轻微", "中等", "严重", "危急"];
  const INCIDENT_TYPES = ["表面划痕", "齿孔破损", "断片", "霉斑", "醋酸综合症", "褪色", "接片失效", "涂层脱落", "其他"];

  // ---------- 默认数据 ----------
  function defaultDoc() {
    return {
      clock: {},
      reelTitle: "春日试映A卷",
      reels: [
        { id: "r1", name: "春日试映A卷" },
        { id: "r2", name: "夏末资料B卷" }
      ],
      segments: [
        { id: "s-a001", reelId: "r1", code: "A-001", duration: 18, shift: "正常", damage: "完好", note: "开场街景，节奏平稳，适合保留原顺序。", thumb: "" },
        { id: "s-a006", reelId: "r1", code: "A-006", duration: 9, shift: "偏红", damage: "轻微划痕", note: "人物近景左侧有划痕，试映时留意是否明显。", thumb: "" },
        { id: "s-a012", reelId: "r1", code: "A-012", duration: 14, shift: "褪色", damage: "接片松动", note: "接片位置靠近段尾，放映前建议重新压平。", thumb: "" },
        { id: "s-b003", reelId: "r2", code: "B-003", duration: 22, shift: "偏青", damage: "霉斑", note: "片尾约两尺有白色霉点，需清洁后再扫。", thumb: "" }
      ],
      people: [
        { id: "p-zmin", name: "周敏", role: "修复技师" },
        { id: "p-llan", name: "李岚", role: "修复技师" },
        { id: "p-ctuo", name: "陈拓", role: "复检员" },
        { id: "p-wqing", name: "王箐", role: "主管" }
      ],
      devices: [
        { id: "d-u1", name: "超声波洁片机 U-1" },
        { id: "d-o2", name: "光学印片机 O-2" },
        { id: "d-p1", name: "接片压台 P-1" }
      ],
      inventoryItems: [
        { id: "i-tape", name: "接片胶纸", sku: "TAPE-08", type: "material", unit: "卷", baseStock: 12 },
        { id: "i-film", name: "醋酸片基补条", sku: "FILM-35", type: "material", unit: "米", baseStock: 5 },
        { id: "i-rep", name: "替换片段 REP-11", sku: "REP-11", type: "segment", unit: "个", baseStock: 2 },
        { id: "i-liquid", name: "胶片清洁液", sku: "LIQ-02", type: "material", unit: "瓶", baseStock: 4 }
      ],
      // 库存流水账（离线合并时按 id 并集，库存自然收敛）
      stockMovements: [],
      // 预留单
      reservations: [],
      cases: [
        {
          id: "c-seed-1",
          code: "IR-2026-001",
          title: "A-006 人物近景划痕",
          reelId: "r1",
          segmentCodes: ["A-006"],
          incidentType: "表面划痕",
          severity: "中等",
          description: "人物近景左侧约 3 格有纵向划痕，需要清洁抛光后复检。",
          responsiblePersonId: "p-wqing",
          damageConfirmed: true,
          status: "registered",
          booking: null,
          repair: null,
          review: null,
          closeRecord: null,
          evidence: [
            { id: "ev-seed-1", kind: "note", name: "初检记录", note: "人物近景左侧划痕，约3格，已现场确认。", dataUrl: "", hash: "" }
          ],
          history: [
            { id: "h-seed-1", opId: "seed", ts: "2026-09-10T09:00:00.000Z", action: "登记", actorId: "p-wqing", detail: "事故案例登记，严重度：中等" }
          ],
          createdAt: "2026-09-10T09:00:00.000Z",
          updatedAt: "2026-09-10T09:00:00.000Z"
        }
      ]
    };
  }

  // 旧版“分镜条核对台”数据迁移
  function migrateOldDesk() {
    try {
      const raw = localStorage.getItem(OLD_APP_KEY);
      if (!raw) return null;
      const old = JSON.parse(raw);
      const doc = defaultDoc();
      if (old.reelTitle) {
        doc.reelTitle = old.reelTitle;
        doc.reels[0].name = old.reelTitle;
      }
      if (Array.isArray(old.segments) && old.segments.length) {
        doc.segments = old.segments.map((s) => ({
          id: s.id || uid("s"),
          reelId: "r1",
          code: s.code || "未编号",
          duration: Number(s.duration) || 0,
          shift: s.shift || "正常",
          damage: s.damage || "完好",
          note: s.note || "",
          thumb: s.thumb || ""
        }));
        doc.cases = [];
      }
      return doc;
    } catch {
      return null;
    }
  }

  // ---------- 向量时钟 ----------
  function bumpClock(clock, clientId) {
    const next = { ...clock };
    next[clientId] = (next[clientId] || 0) + 1;
    return next;
  }

  function clockDominates(a, b) {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    let strict = false;
    for (const k of keys) {
      const av = a?.[k] || 0;
      const bv = b?.[k] || 0;
      if (av < bv) return false;
      if (av > bv) strict = true;
    }
    return strict;
  }

  function clocksEqual(a, b) {
    return !clockDominates(a, b) && !clockDominates(b, a) && JSON.stringify(a) === JSON.stringify(b);
  }

  function mergeClocks(a, b) {
    const out = {};
    for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
      out[k] = Math.max(a?.[k] || 0, b?.[k] || 0);
    }
    return out;
  }

  // ---------- 查询助手 ----------
  function caseById(doc, id) {
    return doc.cases.find((c) => c.id === id) || null;
  }

  function personById(doc, id) {
    return doc.people.find((p) => p.id === id) || null;
  }

  function deviceById(doc, id) {
    return doc.devices.find((d) => d.id === id) || null;
  }

  function itemById(doc, id) {
    return doc.inventoryItems.find((i) => i.id === id) || null;
  }

  function reelById(doc, id) {
    return doc.reels.find((r) => r.id === id) || null;
  }

  function stockOf(doc, itemId) {
    const item = itemById(doc, itemId);
    if (!item) return 0;
    const delta = doc.stockMovements
      .filter((m) => m.itemId === itemId)
      .reduce((sum, m) => sum + m.delta, 0);
    return item.baseStock + delta;
  }

  function reservedQty(doc, itemId) {
    return doc.reservations
      .filter((r) => r.itemId === itemId && r.status === "reserved")
      .reduce((s, r) => s + r.qty, 0);
  }

  function consumedQty(doc, itemId) {
    return doc.reservations
      .filter((r) => r.itemId === itemId && r.status === "consumed")
      .reduce((s, r) => s + r.qty, 0);
  }

  function toTime(value) {
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : NaN;
  }

  function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  // 技师与设备都不能在同一时段被其他在办案例占用
  function findBookingConflict(doc, booking, excludeCaseId) {
    const start = toTime(booking.start);
    const end = toTime(booking.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      throw new AppError("BAD_TIME", "派工时段无效：结束时间必须晚于开始时间。");
    }
    for (const c of doc.cases) {
      if (c.id === excludeCaseId || c.status === "closed" || !c.booking) continue;
      const b = c.booking;
      if (overlaps(start, end, toTime(b.start), toTime(b.end))) {
        if (b.technicianId === booking.technicianId) {
          return { kind: "technician", caseId: c.id };
        }
        if (b.deviceId === booking.deviceId) {
          return { kind: "device", caseId: c.id };
        }
      }
    }
    return null;
  }

  function nextCaseCode(doc) {
    const year = new Date().getFullYear();
    const prefix = `IR-${year}-`;
    let max = 0;
    for (const c of doc.cases) {
      const m = c.code?.match(new RegExp(`^${prefix}(\\d+)$`));
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `${prefix}${String(max + 1).padStart(3, "0")}`;
  }

  function appendHistory(doc, incident, action, actorId, detail) {
    incident.history.push({ id: uid("h"), opId: uid("op"), ts: nowIso(), action, actorId, detail });
    incident.updatedAt = nowIso();
  }

  function makeEvidence(partial) {
    const ev = {
      id: uid("ev"),
      kind: partial.kind || (partial.dataUrl ? "photo" : "note"),
      name: partial.name || (partial.dataUrl ? "影像证据" : "文字记录"),
      note: partial.note || "",
      dataUrl: partial.dataUrl || "",
      hash: ""
    };
    ev.hash = evidenceHash(ev);
    return ev;
  }

  function evidenceHash(ev) {
    return hashContent(`${ev.kind}|${ev.name}|${ev.note}|${ev.dataUrl || ""}`);
  }

  // ---------- 持久化封装（支持故障注入，用于“保存失败”测试） ----------
  function createAdapter(storage) {
    let failNext = false;
    return {
      get(key) {
        return storage.getItem(key);
      },
      set(key, value) {
        if (failNext) {
          failNext = false;
          const err = new Error("模拟的持久化失败（localStorage 不可用）");
          err.code = "SAVE_FAILED";
          throw err;
        }
        storage.setItem(key, value);
      },
      setFailNext(v) {
        failNext = !!v;
      }
    };
  }

  // ---------- 三方合并 ----------
  const CASE_SCALARS = [
    { key: "code", label: "案例编号" },
    { key: "title", label: "标题" },
    { key: "reelId", label: "胶片卷", kind: "reel" },
    { key: "incidentType", label: "事故类型" },
    { key: "severity", label: "严重度" },
    { key: "responsiblePersonId", label: "责任人", kind: "person" },
    { key: "damageConfirmed", label: "损坏确认", kind: "bool" },
    { key: "status", label: "流转状态", kind: "status" },
    { key: "description", label: "事故描述" }
  ];
  const CASE_RECORDS = [
    { key: "booking", label: "派工信息" },
    { key: "repair", label: "修复记录" },
    { key: "review", label: "复检记录" },
    { key: "closeRecord", label: "关闭记录" }
  ];
  const SEGMENT_SCALARS = [
    { key: "reelId", label: "胶片卷", kind: "reel" },
    { key: "code", label: "片段编号" },
    { key: "duration", label: "时长(秒)" },
    { key: "shift", label: "颜色偏移" },
    { key: "damage", label: "破损情况" },
    { key: "note", label: "备注" }
  ];
  const ITEM_SCALARS = [
    { key: "name", label: "名称" },
    { key: "sku", label: "编号" },
    { key: "unit", label: "单位" },
    { key: "baseStock", label: "期初库存" }
  ];
  const PERSON_SCALARS = [
    { key: "name", label: "姓名" },
    { key: "role", label: "岗位" }
  ];
  const DEVICE_SCALARS = [{ key: "name", label: "设备名称" }];
  const REEL_SCALARS = [{ key: "name", label: "胶片卷名称" }];
  const RESERVATION_SCALARS = [
    { key: "status", label: "预留状态" },
    { key: "qty", label: "数量" }
  ];

  function displayValue(doc, def, value) {
    if (value === null || value === undefined || value === "") return "（空）";
    if (def.kind === "bool") return value ? "已确认" : "未确认";
    if (def.kind === "person") return personById(doc, value)?.name || value;
    if (def.kind === "reel") return reelById(doc, value)?.name || value;
    if (def.kind === "status") return STATUS[value] || value;
    if (def.key === "start" || def.key === "end") return String(value).replace("T", " ");
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function isEmptyValue(v) {
    return v === undefined || v === null || v === "";
  }

  function threeWay(doc, base, local, incoming, def, context, conflicts, keyPrefix, decide, baseMissing) {
    const bv = base?.[def.key];
    const lv = local?.[def.key];
    const iv = incoming?.[def.key];
    const lb = JSON.stringify(bv ?? null);
    const ls = JSON.stringify(lv ?? null);
    const ii = JSON.stringify(iv ?? null);
    if (ls === ii) return lv; // 两边一致
    if (!baseMissing) {
      if (ls === lb) return iv; // 只改了外来
      if (ii === lb) return lv; // 只改了本地
    } else {
      // 共同基端没有这条记录：空值视为“未填写”，不构成修改
      if (isEmptyValue(lv)) return iv;
      if (isEmptyValue(iv)) return lv;
    }
    // 双方都改且不同 —— 冲突，逐项裁决
    const key = `${keyPrefix}:${def.key}`;
    let side = "local";
    if (decide) {
      side = decide(key);
    } else {
      conflicts.push({
        key,
        label: def.label,
        base: displayValue(doc, def, bv),
        local: displayValue(doc, def, lv),
        incoming: displayValue(doc, def, iv),
        ...context
      });
    }
    return side === "incoming" ? iv : lv;
  }

  function mergeRecordCollection(cfg, baseList, localList, incomingList, doc, conflicts, decide, logs) {
    const baseMap = new Map((baseList || []).map((r) => [r.id, r]));
    const localMap = new Map((localList || []).map((r) => [r.id, r]));
    const inMap = new Map((incomingList || []).map((r) => [r.id, r]));
    const out = [];
    const allIds = new Set([...localMap.keys(), ...inMap.keys()]);
    for (const id of allIds) {
      const l = localMap.get(id);
      const i = inMap.get(id);
      if (l && !i) {
        out.push(clone(l));
        continue;
      }
      if (i && !l) {
        out.push(clone(i));
        logs.push(`${cfg.entityName}“${cfg.nameOf(i)}”来自离线页的新增已并入。`);
        continue;
      }
      const b = baseMap.get(id) || {};
      const merged = { id, ...clone(l) };
      for (const def of cfg.scalars) {
        merged[def.key] = threeWay(doc, b, l, i, def, { entity: cfg.entityName, entityName: cfg.nameOf(l) }, conflicts, `${cfg.key}:${id}`, decide, !baseMap.has(id));
      }
      out.push(merged);
    }
    return out;
  }

  function mergeEvidence(localEv, inEv, logs) {
    const byHash = new Map();
    for (const ev of localEv) {
      const h = ev.hash || evidenceHash(ev);
      byHash.set(h, { ...ev, hash: h });
    }
    let absorbed = 0;
    for (const ev of inEv) {
      const h = ev.hash || evidenceHash(ev);
      if (byHash.has(h)) {
        absorbed++;
        // 保留信息更完整的一份（例如带图片的）
        const exist = byHash.get(h);
        if ((ev.dataUrl?.length || 0) > (exist.dataUrl?.length || 0)) byHash.set(h, { ...ev, hash: h });
        continue;
      }
      byHash.set(h, { ...ev, hash: h });
    }
    if (absorbed) logs.push(`完全重复的证据只吸收一次，跳过 ${absorbed} 条重复证据。`);
    return [...byHash.values()];
  }

  function mergeHistory(localH, inH) {
    const byOp = new Map(localH.map((h) => [h.opId || h.id, h]));
    for (const h of inH) {
      const k = h.opId || h.id;
      if (!byOp.has(k)) byOp.set(k, h);
    }
    return [...byOp.values()].sort((a, b) => new Date(a.ts) - new Date(b.ts));
  }

  function mergeSegmentCodes(a, b) {
    return [...new Set([...(a || []), ...(b || [])])];
  }

  function normalizeCode(code) {
    return String(code || "").trim().toUpperCase().replace(/\s+/g, "");
  }

  // 同一案例的三方合并（同 id，或跨页重复登记的同编号案例）
  function mergeCase(doc, base, local, incoming, conflicts, decide, logs, keyPrefix, baseMissing) {
    const merged = { id: local.id, ...clone(local) };
    const ctx = { entity: "事故案例", entityName: `${local.code} ${local.title}` };
    for (const def of CASE_SCALARS) {
      merged[def.key] = threeWay(doc, base, local, incoming, def, ctx, conflicts, keyPrefix, decide, baseMissing);
    }
    for (const rec of CASE_RECORDS) {
      const bv = base?.[rec.key];
      const lv = local[rec.key];
      const iv = incoming[rec.key];
      const lb = JSON.stringify(bv ?? null);
      const ls = JSON.stringify(lv ?? null);
      const ii = JSON.stringify(iv ?? null);
      if (ls === ii) {
        merged[rec.key] = lv;
      } else if (!baseMissing && lb === ls) {
        merged[rec.key] = iv;
      } else if (!baseMissing && lb === ii) {
        merged[rec.key] = lv;
      } else if (baseMissing && isEmptyValue(lv)) {
        merged[rec.key] = iv;
      } else if (baseMissing && isEmptyValue(iv)) {
        merged[rec.key] = lv;
      } else {
        const key = `${keyPrefix}:${rec.key}`;
        let side = "local";
        if (decide) {
          side = decide(key);
        } else {
          conflicts.push({
            key,
            label: rec.label,
            base: bv ? "已有记录" : "（空）",
            local: lv ? `${rec.label}已填写` : "（空）",
            incoming: iv ? `${rec.label}已填写` : "（空）",
            ...ctx
          });
        }
        merged[rec.key] = side === "incoming" ? iv : lv;
      }
    }
    merged.segmentCodes = mergeSegmentCodes(local.segmentCodes, incoming.segmentCodes);
    merged.evidence = mergeEvidence(local.evidence || [], incoming.evidence || [], logs);
    merged.history = mergeHistory(local.history || [], incoming.history || []);
    merged.createdAt = local.createdAt < incoming.createdAt ? local.createdAt : incoming.createdAt;
    merged.updatedAt = local.updatedAt > incoming.updatedAt ? local.updatedAt : incoming.updatedAt;
    return merged;
  }

  // 主合并入口：decide 缺省时收集冲突；提交裁决时传入 decisions
  function mergeDocuments(base, local, incoming, decisions) {
    const doc = {}; // 供 displayValue 查名称，使用合并双方并集
    doc.people = [...local.people, ...incoming.people];
    doc.reels = [...local.reels, ...incoming.reels];
    const decide = decisions ? (key) => decisions[key] || "local" : null;
    const conflicts = [];
    const logs = [];
    const merged = {};

    merged.clock = mergeClocks(local.clock, incoming.clock);
    merged.reelTitle = threeWay(
      doc,
      { reelTitle: base.reelTitle },
      { reelTitle: local.reelTitle },
      { reelTitle: incoming.reelTitle },
      { key: "reelTitle", label: "胶片卷标题" },
      { entity: "全局", entityName: "胶片卷标题" },
      conflicts,
      "meta:reelTitle",
      decide
    );

    merged.reels = mergeRecordCollection(
      { key: "reels", entityName: "胶片卷", nameOf: (r) => r.name, scalars: REEL_SCALARS },
      base.reels, local.reels, incoming.reels, doc, conflicts, decide, logs
    );
    merged.people = mergeRecordCollection(
      { key: "people", entityName: "人员", nameOf: (r) => r.name, scalars: PERSON_SCALARS },
      base.people, local.people, incoming.people, doc, conflicts, decide, logs
    );
    merged.devices = mergeRecordCollection(
      { key: "devices", entityName: "设备", nameOf: (r) => r.name, scalars: DEVICE_SCALARS },
      base.devices, local.devices, incoming.devices, doc, conflicts, decide, logs
    );
    merged.inventoryItems = mergeRecordCollection(
      { key: "inventoryItems", entityName: "库存项", nameOf: (r) => r.name, scalars: ITEM_SCALARS },
      base.inventoryItems, local.inventoryItems, incoming.inventoryItems, doc, conflicts, decide, logs
    );
    merged.segments = mergeRecordCollection(
      { key: "segments", entityName: "片段", nameOf: (r) => r.code, scalars: SEGMENT_SCALARS },
      base.segments, local.segments, incoming.segments, doc, conflicts, decide, logs
    );

    // 流水账与预留按 id 并集（幂等）
    const movMap = new Map();
    for (const m of [...(local.stockMovements || []), ...(incoming.stockMovements || [])]) {
      if (!movMap.has(m.id)) movMap.set(m.id, m);
    }
    merged.stockMovements = [...movMap.values()].sort((a, b) => new Date(a.ts) - new Date(b.ts));
    merged.reservations = mergeRecordCollection(
      { key: "reservations", entityName: "预留单", nameOf: (r) => r.id, scalars: RESERVATION_SCALARS },
      base.reservations, local.reservations, incoming.reservations, doc, conflicts, decide, logs
    );

    // 案例：先按 id 配对，再按编号识别跨页重复登记
    const baseCases = new Map((base.cases || []).map((c) => [c.id, c]));
    const localCases = new Map((local.cases || []).map((c) => [c.id, c]));
    const inCases = new Map((incoming.cases || []).map((c) => [c.id, c]));
    const usedIncoming = new Set();
    const outCases = [];

    for (const lc of local.cases || []) {
      if (inCases.has(lc.id)) {
        outCases.push(mergeCase(doc, baseCases.get(lc.id) || {}, lc, inCases.get(lc.id), conflicts, decide, logs, `case:${lc.id}`, !baseCases.has(lc.id)));
        usedIncoming.add(lc.id);
        continue;
      }
      // 同编号、不同 id：跨页重复登记
      const dup = (incoming.cases || []).find(
        (ic) => !usedIncoming.has(ic.id) && normalizeCode(ic.code) === normalizeCode(lc.code)
      );
      if (dup) {
        usedIncoming.add(dup.id);
        const semanticStrip = (x) => {
          const { id, history, evidence, createdAt, updatedAt, ...rest } = x;
          return rest;
        };
        const identical = JSON.stringify(semanticStrip(lc)) === JSON.stringify(semanticStrip(dup));
        const dkey = `dup:${lc.id}:${dup.id}`;
        let survivor = "local";
        if (decide) {
          survivor = decisions[dkey] || "local";
        } else if (identical) {
          logs.push(`案例“${lc.code}”在两个页面完全重复登记，只吸收一次。`);
        } else {
          conflicts.push({
            key: dkey,
            kind: "duplicate",
            label: "重复登记的案例",
            localId: lc.id,
            incomingId: dup.id,
            base: "—",
            local: `本页：${lc.code} ${lc.title}（${lc.status ? STATUS[lc.status] : ""}）`,
            incoming: `离线页：${dup.code} ${dup.title}（${dup.status ? STATUS[dup.status] : ""}）`,
            entity: "事故案例",
            entityName: lc.code
          });
        }
        // 始终以本页为 local 侧合并字段；mergeCase 内部生成的冲突键已带 keyPrefix(dkey)，
        // 与合并中心 UI 的行键一致，因此裁决函数直接透传，不再二次包装。
        const mergedCase = mergeCase(doc, {}, lc, dup, conflicts, decide, logs, dkey);
        if (survivor === "incoming") {
          mergedCase.id = dup.id;
          mergedCase.code = dup.code;
        }
        outCases.push(mergedCase);
        continue;
      }
      outCases.push(clone(lc));
    }
    for (const ic of incoming.cases || []) {
      if (!usedIncoming.has(ic.id)) {
        outCases.push(clone(ic));
        logs.push(`事故案例“${ic.code}”来自离线页的新增已并入。`);
      }
    }
    merged.cases = outCases;
    return { merged, conflicts, logs };
  }

  const SESSION_KEY = "zfl17-film-rescue-session-id";

  // ---------- Store ----------
  function createStore(options = {}) {
    const adapter = options.adapter || createAdapter(localStorage);
    const listeners = [];
    // clientId 是“标签页会话身份”：刷新同页应保持，但不同标签页必须不同，
    // 否则向量时钟无法区分并发方。优先注入项，其次 sessionStorage，最后新建。
    let clientId = options.clientId;
    if (!clientId && typeof sessionStorage !== "undefined") {
      clientId = sessionStorage.getItem(SESSION_KEY);
    }
    if (!clientId) clientId = uid("client");
    if (typeof sessionStorage !== "undefined") {
      try {
        sessionStorage.setItem(SESSION_KEY, clientId);
      } catch {
        /* 会话存储不可用时退化为内存身份 */
      }
    }
    let envelope = load();
    envelope.clientId = clientId;
    // 首次启动也落盘一次基线，保证刷新/多标签页/故障注入时有可回滚的已提交状态
    try {
      persist();
    } catch {
      /* 存储被禁用时允许内存态启动 */
    }

    function load() {
      const raw = adapter.get(APP_KEY);
      if (raw) {
        try {
          const env = JSON.parse(raw);
          if (env && env.doc) {
            env.undo = Array.isArray(env.undo) ? env.undo : [];
            env.redo = Array.isArray(env.redo) ? env.redo : [];
            env.base = env.base || clone(env.doc);
            return env;
          }
        } catch {
          /* 落盘损坏则重建 */
        }
      }
      const doc = migrateOldDesk() || defaultDoc();
      return { clientId, doc, base: clone(doc), undo: [], redo: [] };
    }

    function persist() {
      adapter.set(
        APP_KEY,
        JSON.stringify({
          v: 2,
          clientId: envelope.clientId,
          doc: envelope.doc,
          base: envelope.base,
          undo: envelope.undo.slice(-UNDO_LIMIT),
          redo: envelope.redo
        })
      );
    }

    function contentOf(doc) {
      const { clock, ...content } = doc;
      return clone(content);
    }

    function adoptContent(content) {
      const doc = clone(content);
      doc.clock = bumpClock(envelope.doc.clock, envelope.clientId);
      return doc;
    }

    function emit() {
      for (const fn of listeners) {
        try {
          fn(envelope.doc);
        } catch {
          /* 监听异常不影响事务 */
        }
      }
    }

    // 在草稿上执行修改；任何校验失败或落盘失败都会整单回滚
    function apply(mutator, label) {
      const draft = clone(envelope.doc);
      const ctx = {
        clientId: envelope.clientId,
        opId: uid("op"),
        ts: nowIso(),
        uid
      };
      mutator(draft, ctx);
      draft.clock = bumpClock(envelope.doc.clock, envelope.clientId);
      const undo = [...envelope.undo, contentOf(envelope.doc)].slice(-UNDO_LIMIT);
      const candidate = { ...envelope, doc: draft, undo, redo: [] };
      const old = envelope;
      envelope = candidate;
      try {
        persist();
      } catch (err) {
        envelope = old; // 整单回滚：内存状态恢复到事务前
        throw new AppError("SAVE_FAILED", `保存失败，本次改动已回滚（${err.message}）`);
      }
      emit();
      return { doc: draft, label, result: ctx.result };
    }

    function undo() {
      if (!envelope.undo.length) return false;
      const content = envelope.undo[envelope.undo.length - 1];
      const draft = adoptContent(content);
      const nextEnv = {
        ...envelope,
        doc: draft,
        undo: envelope.undo.slice(0, -1),
        redo: [...envelope.redo, contentOf(envelope.doc)]
      };
      const old = envelope;
      envelope = nextEnv;
      try {
        persist();
      } catch (err) {
        envelope = old;
        throw new AppError("SAVE_FAILED", `保存失败，撤销未生效（${err.message}）`);
      }
      emit();
      return true;
    }

    function redo() {
      if (!envelope.redo.length) return false;
      const content = envelope.redo[envelope.redo.length - 1];
      const draft = adoptContent(content);
      const nextEnv = {
        ...envelope,
        doc: draft,
        undo: [...envelope.undo, contentOf(envelope.doc)].slice(-UNDO_LIMIT),
        redo: envelope.redo.slice(0, -1)
      };
      const old = envelope;
      envelope = nextEnv;
      try {
        persist();
      } catch (err) {
        envelope = old;
        throw new AppError("SAVE_FAILED", `保存失败，重做未生效（${err.message}）`);
      }
      emit();
      return true;
    }

    // 接收其他标签页 / 离线快照文档：快进、忽略或三方合并
    function ingest(incomingDoc) {
      const local = envelope.doc;
      if (clocksEqual(local.clock, incomingDoc.clock)) {
        return { status: "identical" };
      }
      if (clockDominates(incomingDoc.clock, local.clock)) {
        const old = envelope;
        envelope = { ...envelope, doc: clone(incomingDoc), base: clone(incomingDoc) };
        try {
          persist();
        } catch (err) {
          envelope = old;
          throw new AppError("SAVE_FAILED", `保存失败，远端修改未接收（${err.message}）`);
        }
        emit();
        return { status: "fastforward" };
      }
      if (clockDominates(local.clock, incomingDoc.clock)) {
        return { status: "behind" };
      }
      const plan = mergeDocuments(envelope.base, local, incomingDoc);
      if (!plan.conflicts.length) {
        return commitMerge(incomingDoc, {});
      }
      return { status: "conflict", incomingDoc, conflicts: plan.conflicts, logs: plan.logs };
    }

    // 冲突全部由 UI 逐项裁决后，携带 decisions 提交
    function commitMerge(incomingDoc, decisions) {
      const { merged, conflicts, logs } = mergeDocuments(envelope.base, envelope.doc, incomingDoc, decisions);
      const draft = clone(merged);
      draft.clock = mergeClocks(envelope.doc.clock, incomingDoc.clock);
      // 再 bump 一次，保证合并提交对所有端都是新后代
      draft.clock = bumpClock(draft.clock, envelope.clientId);
      const nextEnv = {
        ...envelope,
        doc: draft,
        base: clone(draft),
        undo: [...envelope.undo, contentOf(envelope.doc)].slice(-UNDO_LIMIT),
        redo: []
      };
      const old = envelope;
      envelope = nextEnv;
      try {
        persist();
      } catch (err) {
        envelope = old;
        throw new AppError("SAVE_FAILED", `保存失败，合并未提交（${err.message}）`);
      }
      emit();
      return { status: "merged", logs };
    }

    // 由 UI 保存待裁决计划时调用（携带外来文档与逐项裁决）
    function resolveConflict(incomingDoc, decisions) {
      return commitMerge(incomingDoc, decisions);
    }

    function exportSnapshot() {
      return {
        kind: "film-rescue-offline-snapshot",
        version: 1,
        exportedAt: nowIso(),
        clientId: envelope.clientId,
        doc: envelope.doc
      };
    }

    function exportIncidentPackage(caseId) {
      const incident = caseById(envelope.doc, caseId);
      if (!incident) throw new AppError("NOT_FOUND", "找不到要导出的事故案例。");
      return {
        kind: "film-rescue-incident-package",
        version: 1,
        exportedAt: nowIso(),
        reelTitle: envelope.doc.reelTitle,
        incident: clone(incident),
        references: {
          reel: reelById(envelope.doc, incident.reelId),
          responsible: personById(envelope.doc, incident.responsiblePersonId),
          segments: envelope.doc.segments.filter((s) => incident.segmentCodes.includes(s.code)),
          reservations: envelope.doc.reservations.filter((r) => r.caseId === incident.id).map((r) => ({
            ...r,
            item: itemById(envelope.doc, r.itemId)
          })),
          movements: envelope.doc.stockMovements.filter((m) => m.caseId === incident.id)
        }
      };
    }

    return {
      get doc() {
        return envelope.doc;
      },
      get clientId() {
        return envelope.clientId;
      },
      canUndo: () => envelope.undo.length > 0,
      canRedo: () => envelope.redo.length > 0,
      onChange(fn) {
        listeners.push(fn);
      },
      apply,
      undo,
      redo,
      ingest,
      resolveConflict,
      exportSnapshot,
      exportIncidentPackage,
      adapter,
      // 测试/调试
      _envelope: () => envelope
    };
  }

  // ---------- 领域操作（在事务 mutator 中调用） ----------
  const Ops = {
    registerCase(doc, ctx, data) {
      const code = (data.code || "").trim() || nextCaseCode(doc);
      if (doc.cases.some((c) => normalizeCode(c.code) === normalizeCode(code))) {
        throw new AppError("DUP_CODE", `案例编号 ${code} 已存在。`);
      }
      if (!data.title?.trim()) throw new AppError("NO_TITLE", "请填写事故标题。");
      if (!data.reelId || !reelById(doc, data.reelId)) throw new AppError("NO_REEL", "请选择所属胶片卷。");
      if (!SEVERITIES.includes(data.severity)) throw new AppError("BAD_SEVERITY", "请选择严重度。");
      if (!INCIDENT_TYPES.includes(data.incidentType)) throw new AppError("BAD_TYPE", "请选择事故类型。");
      const incident = {
        id: uid("c"),
        code,
        title: data.title.trim(),
        reelId: data.reelId,
        segmentCodes: data.segmentCodes || [],
        incidentType: data.incidentType,
        severity: data.severity,
        description: (data.description || "").trim(),
        responsiblePersonId: data.responsiblePersonId || "",
        damageConfirmed: !!data.damageConfirmed,
        status: "registered",
        booking: null,
        repair: null,
        review: null,
        closeRecord: null,
        evidence: [],
        history: [],
        createdAt: ctx.ts,
        updatedAt: ctx.ts
      };
      for (const ev of data.evidence || []) incident.evidence.push(makeEvidence(ev));
      incident.history.push({
        id: uid("h"),
        opId: ctx.opId,
        ts: ctx.ts,
        action: "登记",
        actorId: data.actorId || "",
        detail: `事故案例登记，严重度：${incident.severity}${incident.damageConfirmed ? "，损坏已确认" : ""}`
      });
      doc.cases.push(incident);
      return incident;
    },

    addEvidence(doc, ctx, caseId, partial, actorId) {
      const incident = caseById(doc, caseId);
      if (!incident) throw new AppError("NOT_FOUND", "找不到事故案例。");
      if (incident.status === "closed") throw new AppError("CASE_CLOSED", "案例已关闭，不能再补充证据。");
      if (!partial.dataUrl && !(partial.note || "").trim()) {
        throw new AppError("EMPTY_EVIDENCE", "证据内容为空：请上传图片或填写文字记录。");
      }
      const ev = makeEvidence(partial);
      if (incident.evidence.some((e) => (e.hash || evidenceHash(e)) === ev.hash)) {
        throw new AppError("DUP_EVIDENCE", "完全相同的证据已经存在，只保留一份。");
      }
      incident.evidence.push(ev);
      appendHistory(doc, incident, "补证", actorId, `补充证据：${ev.name}`);
      return ev;
    },

    confirmDamage(doc, ctx, caseId, actorId) {
      const incident = caseById(doc, caseId);
      if (!incident) throw new AppError("NOT_FOUND", "找不到事故案例。");
      if (incident.damageConfirmed) throw new AppError("ALREADY_CONFIRMED", "损坏情况已经确认过。");
      incident.damageConfirmed = true;
      appendHistory(doc, incident, "确认损坏", actorId, "现场损坏情况已确认。");
    },

    dispatch(doc, ctx, caseId, booking, actorId) {
      const incident = caseById(doc, caseId);
      if (!incident) throw new AppError("NOT_FOUND", "找不到事故案例。");
      if (!["registered", "dispatched"].includes(incident.status)) {
        throw new AppError("BAD_STATUS", `当前状态为「${STATUS[incident.status]}」，不能派工。`);
      }
      if (!booking.technicianId || !personById(doc, booking.technicianId)) {
        throw new AppError("NO_TECHNICIAN", "请选择修复技师。");
      }
      const tech = personById(doc, booking.technicianId);
      if (tech.role !== "修复技师") throw new AppError("NOT_TECHNICIAN", `${tech.name}不是修复技师，不能派工修复。`);
      if (!booking.deviceId || !deviceById(doc, booking.deviceId)) {
        throw new AppError("NO_DEVICE", "请选择修复设备。");
      }
      const conflict = findBookingConflict(doc, booking, caseId);
      if (conflict) {
        const other = caseById(doc, conflict.caseId);
        const who = conflict.kind === "technician" ? `技师 ${tech.name}` : `设备 ${deviceById(doc, booking.deviceId).name}`;
        throw new AppError("RESOURCE_CONFLICT", `资源冲突：${who} 在该时段已被案例 ${other.code} 占用，请改时段或换人/换机。`);
      }
      incident.booking = {
        technicianId: booking.technicianId,
        deviceId: booking.deviceId,
        start: booking.start,
        end: booking.end
      };
      incident.status = "dispatched";
      appendHistory(
        doc,
        incident,
        "派工",
        actorId,
        `派工：${tech.name} 使用 ${deviceById(doc, booking.deviceId).name}，${booking.start.replace("T", " ")} ~ ${booking.end.replace("T", " ")}`
      );
    },

    startRepair(doc, ctx, caseId, input, actorId) {
      const incident = caseById(doc, caseId);
      if (!incident) throw new AppError("NOT_FOUND", "找不到事故案例。");
      if (incident.status !== "dispatched") throw new AppError("BAD_STATUS", "只有已派工的案例才能开始修复。");
      if (!incident.booking) throw new AppError("NO_BOOKING", "尚未派工，不能开始修复。");
      // 开始前再次校验资源，防止派工后又有冲突排入
      const conflict = findBookingConflict(doc, incident.booking, caseId);
      if (conflict) {
        const other = caseById(doc, conflict.caseId);
        const who = conflict.kind === "technician"
          ? personById(doc, incident.booking.technicianId).name
          : deviceById(doc, incident.booking.deviceId).name;
        throw new AppError("RESOURCE_CONFLICT", `资源冲突：${who} 在该时段已被案例 ${other.code} 占用。`);
      }

      // 替换片段/材料先从库存预留：逐行试算可用量（库存 - 其他单已预留 - 本单已试算）
      const lines = (input?.materials || []).filter((l) => l.itemId && Number(l.qty) > 0);
      const planned = [];
      for (const line of lines) {
        const item = itemById(doc, line.itemId);
        if (!item) throw new AppError("BAD_ITEM", "选择了不存在的库存项。");
        const qty = Number(line.qty);
        const otherReserved = doc.reservations
          .filter((r) => r.itemId === item.id && r.status === "reserved" && r.caseId !== incident.id)
          .reduce((s, r) => s + r.qty, 0);
        const localPlan = planned.filter((p) => p.itemId === item.id).reduce((s, p) => s + p.qty, 0);
        const available = stockOf(doc, item.id) - otherReserved - localPlan;
        if (qty > available) {
          throw new AppError(
            "INSUFFICIENT_STOCK",
            `库存不足：${item.name}（需预留 ${qty}${item.unit}，可用仅 ${Math.max(available, 0)}${item.unit}），修复单未开始，无任何预留产生。`
          );
        }
        planned.push({ item, qty });
      }

      // 全部可用后一次性建立预留；上面任何失败都不会走到这里 = 整单回滚
      incident.materialPlan = planned.map((p) => ({ itemId: p.item.id, qty: p.qty }));
      for (const { item, qty } of planned) {
        doc.reservations.push({
          id: uid("rsv"),
          opId: ctx.opId,
          caseId: incident.id,
          itemId: item.id,
          qty,
          status: "reserved",
          ts: ctx.ts
        });
      }
      incident.status = "repairing";
      appendHistory(
        doc,
        incident,
        "开始修复",
        actorId,
        `技师开始修复，已预留：${planned.length ? planned.map((p) => `${p.item.name}×${p.qty}`).join("、") : "无用料"}。`
      );
    },

    // 完成修复：预留转为消耗；修复失败则释放全部预留、整单回滚退回派工
    completeRepair(doc, ctx, caseId, input, actorId) {
      const incident = caseById(doc, caseId);
      if (!incident) throw new AppError("NOT_FOUND", "找不到事故案例。");
      if (incident.status !== "repairing") throw new AppError("BAD_STATUS", "案例不在修复中，不能提交修复结果。");
      if (!input.note?.trim()) throw new AppError("NO_REPAIR_NOTE", "请填写修复记录后再提交。");
      if (input.result !== "success" && input.result !== "failed") {
        throw new AppError("BAD_RESULT", "请选择修复结果（成功或失败）。");
      }

      const held = doc.reservations.filter((r) => r.caseId === incident.id && r.status === "reserved");

      if (input.result === "failed") {
        // 失败：释放本单全部预留，库存恢复可用；案例退回派工队列
        const heldNames = held.map((r) => `${itemById(doc, r.itemId).name}×${r.qty}`);
        doc.reservations = doc.reservations.filter((r) => !(r.caseId === incident.id && r.status === "reserved"));
        incident.materialPlan = [];
        incident.status = "dispatched";
        appendHistory(
          doc,
          incident,
          "修复失败回滚",
          actorId,
          `修复失败，整单回滚：已释放预留${heldNames.length ? `（${heldNames.join("、")}）` : ""}，案例退回派工。`
        );
        // 补偿事务正常提交（释放预留、退回派工要留痕落盘），用 ctx.result 告知调用方“修复已回滚”
        ctx.result = {
          repairFailed: true,
          message: "修复失败：已整单回滚，预留的替换片段与材料全部释放，案例退回派工队列。"
        };
        return;
      }

      // 成功：预留转消耗，写库存流水
      for (const rsv of held) {
        rsv.status = "consumed";
        rsv.consumedAt = ctx.ts;
        doc.stockMovements.push({
          id: uid("m"),
          opId: ctx.opId,
          itemId: rsv.itemId,
          delta: -rsv.qty,
          kind: "consume",
          caseId: incident.id,
          ts: ctx.ts
        });
      }

      incident.repair = {
        repairedBy: actorId,
        result: "success",
        note: input.note.trim(),
        replacementSegmentCode: input.replacementSegmentCode || "",
        materials: held.map((r) => ({ itemId: r.itemId, qty: r.qty })),
        ts: ctx.ts
      };
      incident.status = "reviewing";
      incident.review = null;
      appendHistory(
        doc,
        incident,
        "完成修复",
        actorId,
        `修复完成待复检，用料 ${held.length ? held.map((r) => `${itemById(doc, r.itemId).name}×${r.qty}`).join("、") : "无"}。`
      );
    },

    review(doc, ctx, caseId, input, actorId) {
      const incident = caseById(doc, caseId);
      if (!incident) throw new AppError("NOT_FOUND", "找不到事故案例。");
      if (incident.status !== "reviewing") throw new AppError("BAD_STATUS", "案例不在待复检状态。");
      if (!incident.repair) throw new AppError("NO_REPAIR", "尚无修复记录，不能复检。");
      if (actorId === incident.repair.repairedBy) {
        const name = personById(doc, actorId)?.name || "该技师";
        throw new AppError("REVIEW_SAME_PERSON", `越权复检被拦截：复检不能由修复人本人（${name}）完成，请换一位复检员。`);
      }
      if (!input.note?.trim()) throw new AppError("NO_REVIEW_NOTE", "请填写复检意见。");
      if (input.result !== "passed" && input.result !== "failed") throw new AppError("BAD_RESULT", "请选择复检结果。");

      if (input.evidence) {
        const ev = makeEvidence(input.evidence);
        if (!incident.evidence.some((e) => (e.hash || evidenceHash(e)) === ev.hash)) incident.evidence.push(ev);
      }

      incident.review = {
        reviewedBy: actorId,
        result: input.result,
        note: input.note.trim(),
        ts: ctx.ts
      };
      if (input.result === "failed") {
        incident.status = "dispatched";
        appendHistory(doc, incident, "复检不通过", actorId, `复检不通过，退回重新派工修复：${input.note}`);
      } else if (input.result === "passed") {
        incident.status = "approved";
        appendHistory(doc, incident, "复检通过", actorId, `复检通过，待关闭：${input.note}`);
      } else {
        throw new AppError("BAD_RESULT", "复检结果无效。");
      }
    },

    closeCase(doc, ctx, caseId, note, actorId) {
      const incident = caseById(doc, caseId);
      if (!incident) throw new AppError("NOT_FOUND", "找不到事故案例。");
      if (incident.status !== "approved") throw new AppError("BAD_STATUS", "只有复检通过的案例才能关闭。");
      if (!incident.evidence.length) {
        throw new AppError("NO_EVIDENCE", "不能关闭：缺少修复/复检证据，请先上传或登记证据。");
      }
      if (!incident.damageConfirmed) {
        throw new AppError("DAMAGE_UNCONFIRMED", "不能关闭：损坏情况尚未经责任人确认。");
      }
      incident.status = "closed";
      incident.closeRecord = { closedBy: actorId, note: (note || "").trim(), ts: ctx.ts };
      appendHistory(doc, incident, "关闭", actorId, "事故案例关闭，资料归档。");
    },

    restock(doc, ctx, itemId, qty, actorId) {
      const item = itemById(doc, itemId);
      if (!item) throw new AppError("NOT_FOUND", "找不到库存项。");
      const n = Number(qty);
      if (!Number.isFinite(n) || n <= 0) throw new AppError("BAD_QTY", "入库数量必须大于 0。");
      item.baseStock += n;
      doc.stockMovements.push({
        id: uid("m"),
        opId: ctx.opId,
        itemId: item.id,
        delta: 0,
        kind: "restock-base",
        qty: n,
        caseId: "",
        ts: ctx.ts
      });
    }
  };

  window.FilmRescue = {
    KEYS: { APP_KEY, UI_KEY },
    STATUS,
    KANBAN_COLS,
    SEVERITIES,
    INCIDENT_TYPES,
    createStore,
    createAdapter,
    mergeDocuments,
    helpers: {
      uid,
      clone,
      hashContent,
      evidenceHash,
      makeEvidence,
      stockOf,
      reservedQty,
      consumedQty,
      caseById,
      personById,
      deviceById,
      itemById,
      reelById,
      nextCaseCode,
      findBookingConflict,
      normalizeCode,
      nowIso,
      escapeHtml,
      toTime,
      bumpClock,
      clockDominates,
      mergeClocks,
      AppError
    },
    Ops
  };
})();
