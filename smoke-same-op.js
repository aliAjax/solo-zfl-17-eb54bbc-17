// 两个离线页对“同一案例”执行完全相同派工+预留：合并后只算一次，不翻倍、不误报超量
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
  const mk = () =>
    F.createAdapter({
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v))
    });
  return { a: F.createStore({ adapter: mk() }), b: F.createStore({ adapter: mk() }) };
}

// 在同一共享存储上：页 a 先登记案例（双方基端都含该案例），随后两页离线做相同派工+预留
function scenario(stockQty) {
  const { a, b } = twinStores();
  const chief = (d) => d.people.find((p) => p.role === "主管").id;
  const tech = (d) => d.people.find((p) => p.name === "周敏").id;
  let cid;
  a.apply((d, ctx) => {
    const c = F.Ops.registerCase(d, ctx, {
      code: "SAME-OP-1",
      title: "同案同操作",
      reelId: "r1",
      incidentType: "断片",
      severity: "严重",
      damageConfirmed: true,
      actorId: chief(d)
    });
    cid = c.id;
  });
  // b 从共享存储加载到含案例的基端
  const b2 = (() => {
    const store = a._envelope && null;
    return null;
  })();
  return { a, bFresh: null, cid, chief, tech };
}

// 更直接的构造：手动让两页共享同一案例 id 后各自执行相同操作
function build(qty) {
  const store = new Map();
  const mk = () =>
    F.createAdapter({
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v))
    });
  const a = F.createStore({ adapter: mk() });
  const chief = a.doc.people.find((p) => p.role === "主管").id;
  const tech = a.doc.people.find((p) => p.name === "周敏").id;
  let cid;
  a.apply((d, ctx) => {
    const c = F.Ops.registerCase(d, ctx, {
      code: "SAME-OP-1",
      title: "同案同操作",
      reelId: "r1",
      incidentType: "断片",
      severity: "严重",
      damageConfirmed: true,
      actorId: chief
    });
    cid = c.id;
  });
  // b 在案例已落盘后启动 → 与 a 同一基端
  const b = F.createStore({ adapter: mk() });
  // 两页离线执行完全相同的派工 + 预留（预留 id、opId 各自生成）
  const runSame = (s) =>
    s.apply((d, ctx) => {
      F.Ops.dispatch(d, ctx, cid, { technicianId: tech, deviceId: d.devices[0].id, start: "2026-12-10T09:00", end: "2026-12-10T11:00" }, chief);
      F.Ops.startRepair(d, ctx, cid, { materials: [{ itemId: "i-film", qty }] }, tech);
    });
  runSame(a);
  runSame(b);
  return { a, b, cid };
}

// 场景1：小数量（qty=2，库存5）—— 不能算成两次（4），合并后预留应为 2
{
  const { a, b, cid } = build(2);
  ok("各页本侧预留=2", H.reservedQty(a.doc, "i-film") === 2);
  const r = a.ingest(b.doc);
  ok("不被阻止（无违规）", r.status === "merged", r.status);
  ok("相同预留只吸收一次（仍=2，非4）", H.reservedQty(a.doc, "i-film") === 2, `reserved=${H.reservedQty(a.doc, "i-film")}`);
  const c = H.caseById(a.doc, cid);
  const rsvForCase = a.doc.reservations.filter((x) => x.caseId === cid);
  ok("该案例只有一条预留", rsvForCase.length === 1, `n=${rsvForCase.length}`);
  // 流转记录：派工、开始修复各一条（不是两条）
  const dispatchH = c.history.filter((h) => h.action === "派工");
  const startH = c.history.filter((h) => h.action === "开始修复");
  ok("派工记录只一条", dispatchH.length === 1, `n=${dispatchH.length}`);
  ok("开始修复记录只一条", startH.length === 1, `n=${startH.length}`);
  // booking 仍是同一份
  ok("派工 booking 唯一且一致", c.booking && c.booking.start === "2026-12-10T09:00");
  ok("可用量为 5-2=3", H.stockOf(a.doc, "i-film") - H.reservedQty(a.doc, "i-film") === 3);
}

// 场景2：预留量较大（qty=5，库存5，合法临界）—— 合并后仍是5，不能误报缺口5
{
  const { a, b, cid } = build(5);
  const r = a.ingest(b.doc);
  ok("临界合法合并不被阻止", r.status === "merged", r.status);
  ok("预留=5（非10）", H.reservedQty(a.doc, "i-film") === 5, `reserved=${H.reservedQty(a.doc, "i-film")}`);
  ok("可用量为0而非负", H.stockOf(a.doc, "i-film") - H.reservedQty(a.doc, "i-film") === 0);
}

// 场景3：派工完全相同（只吸收一次），但两页预留了不同材料（确实不同的操作都要保留）
{
  const store = new Map();
  const mk = () =>
    F.createAdapter({
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v))
    });
  const a = F.createStore({ adapter: mk() });
  const chief = a.doc.people.find((p) => p.role === "主管").id;
  const tech = a.doc.people.find((p) => p.name === "周敏").id;
  let cid;
  a.apply((d, ctx) => {
    cid = F.Ops.registerCase(d, ctx, {
      code: "DIFF-OP-1",
      title: "不同操作",
      reelId: "r1",
      incidentType: "断片",
      severity: "中等",
      damageConfirmed: true,
      actorId: chief
    }).id;
  });
  const b = F.createStore({ adapter: mk() });
  // 两页派工完全相同；a 预留片基 2 米，b 预留胶纸 3 卷（不同物料）
  a.apply((d, ctx) => {
    F.Ops.dispatch(d, ctx, cid, { technicianId: tech, deviceId: d.devices[0].id, start: "2026-12-11T09:00", end: "2026-12-11T11:00" }, chief);
    F.Ops.startRepair(d, ctx, cid, { materials: [{ itemId: "i-film", qty: 2 }] }, tech);
  });
  b.apply((d, ctx) => {
    F.Ops.dispatch(d, ctx, cid, { technicianId: tech, deviceId: d.devices[0].id, start: "2026-12-11T09:00", end: "2026-12-11T11:00" }, chief);
    F.Ops.startRepair(d, ctx, cid, { materials: [{ itemId: "i-tape", qty: 3 }] }, tech);
  });
  const r = a.ingest(b.doc);
  ok("合并成功不被阻止", r.status === "merged", r.status);
  const film = a.doc.reservations.filter((x) => x.caseId === cid && x.itemId === "i-film").length;
  const tape = a.doc.reservations.filter((x) => x.caseId === cid && x.itemId === "i-tape").length;
  ok("不同物料的两条预留都保留", film === 1 && tape === 1, `film=${film} tape=${tape}`);
  ok("片基预留量=2", H.reservedQty(a.doc, "i-film") === 2);
  ok("胶纸预留量=3", H.reservedQty(a.doc, "i-tape") === 3);
  const c = H.caseById(a.doc, cid);
  ok("相同派工只一条历史", c.history.filter((h) => h.action === "派工").length === 1);
  ok("不同材料的开始修复是两次操作", c.history.filter((h) => h.action === "开始修复").length === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
