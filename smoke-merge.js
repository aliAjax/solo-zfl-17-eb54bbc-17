// 合并结果资源/库存重校验的核心测试
const store0 = new Map();
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: (k) => (store0.has(k) ? store0.get(k) : null),
  setItem: (k, v) => store0.set(k, String(v))
};
globalThis.crypto = require("node:crypto").webcrypto;
globalThis.structuredClone = (v) => JSON.parse(JSON.stringify(v));
require("./core.js");
const F = globalThis.FilmRescue;
const H = F.helpers;

let pass = 0,
  fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++;
  else {
    fail++;
    console.error("FAIL:", name, extra || "");
  }
}

function twinStores() {
  const store = new Map();
  const mkAdapter = () =>
    F.createAdapter({
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v))
    });
  const a = F.createStore({ adapter: mkAdapter() });
  const b = F.createStore({ adapter: mkAdapter() });
  return { a, b, store };
}

function register(s, title, code) {
  return s
    .apply((d, ctx) =>
      F.Ops.registerCase(d, ctx, {
        code,
        title,
        reelId: "r1",
        incidentType: "断片",
        severity: "严重",
        damageConfirmed: true,
        actorId: d.people.find((p) => p.role === "主管").id
      })
    )
    .doc.cases.at(-1).id;
}
const tech1 = (d) => d.people.find((p) => p.name === "周敏").id;
const tech2 = (d) => d.people.find((p) => p.name === "李岚").id;
const chief = (d) => d.people.find((p) => p.role === "主管").id;
const dev1 = (d) => d.devices[0].id;
const dev2 = (d) => d.devices[1].id;
const dispatch = (s, id, who, dev, t1, t2) =>
  s.apply((d, ctx) => F.Ops.dispatch(d, ctx, id, { technicianId: who(d), deviceId: dev(d), start: t1, end: t2 }, chief(d)));

// 场景1：跨页技师时段重叠 → blocked，不写入
{
  const { a, b } = twinStores();
  const ca = register(a, "甲", "MRG-A-1");
  const cb = register(b, "乙", "MRG-B-1");
  dispatch(a, ca, tech1, dev1, "2026-11-01T09:00", "2026-11-01T12:00");
  dispatch(b, cb, tech1, dev2, "2026-11-01T10:00", "2026-11-01T13:00");
  const before = JSON.stringify(a.doc);
  const r = a.ingest(b.doc);
  ok("技师重叠返回 blocked", r.status === "blocked", r.status);
  ok("列出技师重叠", r.violations.some((v) => v.kind === "technician-overlap" && /周敏/.test(v.message)));
  ok("本页未被写入", JSON.stringify(a.doc) === before);
  ok("本页乙案例不存在", !a.doc.cases.some((c) => c.title === "乙"));
}

// 场景2：跨页设备时段重叠（人不同）→ blocked
{
  const { a, b } = twinStores();
  const ca = register(a, "甲", "MRG-A-1");
  const cb = register(b, "乙", "MRG-B-1");
  dispatch(a, ca, tech1, dev1, "2026-11-02T09:00", "2026-11-02T12:00");
  dispatch(b, cb, tech2, dev1, "2026-11-02T11:00", "2026-11-02T11:30");
  const r = a.ingest(b.doc);
  ok("设备重叠返回 blocked", r.status === "blocked", r.status);
  ok("列出设备重叠", r.violations.some((v) => v.kind === "device-overlap"));
  ok("不误报技师重叠", !r.violations.some((v) => v.kind === "technician-overlap"));
}

// 场景3：库存超量（各预留4米，库存5米）→ blocked，可用量不会变负
{
  const { a, b } = twinStores();
  const ca = register(a, "甲", "MRG-A-1");
  const cb = register(b, "乙", "MRG-B-1");
  dispatch(a, ca, tech1, dev1, "2026-11-03T09:00", "2026-11-03T10:00");
  dispatch(b, cb, tech2, dev2, "2026-11-03T14:00", "2026-11-03T15:00");
  a.apply((d, ctx) => F.Ops.startRepair(d, ctx, ca, { materials: [{ itemId: "i-film", qty: 4 }] }, tech1(d)));
  b.apply((d, ctx) => F.Ops.startRepair(d, ctx, cb, { materials: [{ itemId: "i-film", qty: 4 }] }, tech2(d)));
  const before = JSON.stringify(a.doc);
  const r = a.ingest(b.doc);
  ok("库存超量返回 blocked", r.status === "blocked", r.status);
  ok("列出库存超量与缺口", r.violations.some((v) => v.kind === "stock-overrun" && /共预留 8米/.test(v.message) && /缺口 3米/.test(v.message)), JSON.stringify(r.violations));
  ok("本页库存视图未被污染（仍仅预留4）", H.reservedQty(a.doc, "i-film") === 4);
  ok("本页未写入乙", !a.doc.cases.some((c) => c.title === "乙"));
  ok("本页文档字节级未变", JSON.stringify(a.doc) === before);
}

// 场景4：合法合并（时段错开、库存不超）→ merged 正常写入
{
  const { a, b } = twinStores();
  const ca = register(a, "甲", "MRG-A-1");
  const cb = register(b, "乙", "MRG-B-1");
  dispatch(a, ca, tech1, dev1, "2026-11-04T09:00", "2026-11-04T10:00");
  dispatch(b, cb, tech2, dev2, "2026-11-04T10:00", "2026-11-04T11:00"); // 紧邻不重叠
  a.apply((d, ctx) => F.Ops.startRepair(d, ctx, ca, { materials: [{ itemId: "i-film", qty: 2 }] }, tech1(d)));
  b.apply((d, ctx) => F.Ops.startRepair(d, ctx, cb, { materials: [{ itemId: "i-film", qty: 3 }] }, tech2(d))); // 合计5，恰好用完
  const r = a.ingest(b.doc);
  ok("合法合并成功", r.status === "merged", r.status);
  ok("两案例都在", a.doc.cases.some((c) => c.title === "甲") && a.doc.cases.some((c) => c.title === "乙"));
  ok("合计预留5米", H.reservedQty(a.doc, "i-film") === 5);
  ok("合并后可用量为0而非负", H.stockOf(a.doc, "i-film") - H.reservedQty(a.doc, "i-film") === 0);
}

// 场景5：有字段冲突但裁决后合法 → conflict → resolveConflict 成功；裁决无法消除资源冲突则抛错阻止
{
  const { a, b } = twinStores();
  const ca = register(a, "甲", "MRG-A-1");
  const cb = register(b, "乙", "MRG-B-1");
  dispatch(a, ca, tech1, dev1, "2026-11-05T09:00", "2026-11-05T12:00");
  dispatch(b, cb, tech2, dev1, "2026-11-05T11:00", "2026-11-05T11:30");
  b.apply((d) => {
    H.caseById(d, cb).title = "乙改标题";
  });
  a.apply((d) => {
    H.caseById(d, ca).title = "甲改标题";
  });
  const r = a.ingest(b.doc);
  ok("无字段冲突但资源违规 → blocked", r.status === "blocked" && r.violations.length >= 1, r.status);
  let threw = null;
  try {
    a.resolveConflict(b.doc, {});
  } catch (e) {
    threw = e;
  }
  ok("裁决提交仍被资源校验阻止", threw?.code === "MERGE_VIOLATIONS");
  ok("错误携带违规明细", Array.isArray(threw?.violations) && threw.violations.some((v) => v.kind === "device-overlap"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
