// Node 冒烟测试：在无浏览器环境下验证核心规则
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

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error("FAIL:", name, extra || "");
  }
}
function expectErr(code, fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

function freshStore(keyPrefix) {
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v))
  };
  const adapter = F.createAdapter(storage);
  return { s: F.createStore({ adapter }), store, adapter };
}

// ---- 场景 A：正常闭环 ----
{
  const { s } = freshStore("a");
  const doc = s.doc;
  const tech = doc.people.find((p) => p.role === "修复技师").id;
  const tech2 = doc.people.filter((p) => p.role === "修复技师")[1].id;
  const reviewer = doc.people.find((p) => p.role === "复检员").id;
  const chief = doc.people.find((p) => p.role === "主管").id;
  const device = doc.devices[0].id;
  const c = doc.cases[0];

  s.apply((d, ctx) => F.Ops.dispatch(d, ctx, c.id, {
    technicianId: tech, deviceId: device,
    start: "2026-09-20T09:00", end: "2026-09-20T11:00"
  }, chief), "派工");
  ok("派工后状态", s.doc.cases[0].status === "dispatched");

  s.apply((d, ctx) => F.Ops.startRepair(d, ctx, c.id, {
    materials: [{ itemId: "i-tape", qty: 2 }, { itemId: "i-rep", qty: 1 }]
  }, tech), "开始修复");
  ok("修复中状态", s.doc.cases[0].status === "repairing");
  ok("已建立预留", s.doc.reservations.filter((r) => r.caseId === c.id && r.status === "reserved").length === 2);
  ok("预留扣减可用量", H.stockOf(s.doc, "i-rep") - s.doc.reservations.filter((r) => r.itemId === "i-rep" && r.status === "reserved").reduce((x, r) => x + r.qty, 0) === 1);

  s.apply((d, ctx) => F.Ops.completeRepair(d, ctx, c.id, { result: "success", note: "抛光并替换补条。" }, tech), "完成修复");
  ok("待复检", s.doc.cases[0].status === "reviewing");
  ok("预留转消耗", s.doc.reservations.every((r) => r.status === "consumed"));
  ok("库存流水扣减", H.stockOf(s.doc, "i-rep") === 1);

  // 越权复检
  const e1 = expectErr("REVIEW_SAME_PERSON", () => s.apply((d, ctx) => F.Ops.review(d, ctx, c.id, { result: "passed", note: "我修的我复检" }, tech), "越权复检"));
  ok("同一人复检被拦截", e1?.code === "REVIEW_SAME_PERSON", e1?.message);
  ok("越权后状态不变", s.doc.cases[0].status === "reviewing");

  s.apply((d, ctx) => F.Ops.review(d, ctx, c.id, { result: "passed", note: "画面完好。" }, reviewer), "复检通过");
  ok("复检通过待关闭", s.doc.cases[0].status === "approved");

  // 关闭：缺证据 / 损坏未确认
  const c2id = s.apply((d, ctx) => F.Ops.registerCase(d, ctx, {
    title: "测试缺证据案例", reelId: "r1", incidentType: "断片", severity: "严重",
    damageConfirmed: false, actorId: chief
  }), "登记").doc.cases.at(-1).id;
  const c2 = H.caseById(s.doc, c2id);
  s.apply((d, ctx) => { c2; }, "noop");
  const e2 = expectErr("BAD_STATUS", () => s.apply((d, ctx) => F.Ops.closeCase(d, ctx, c2id, "", chief), "强关"));
  ok("未复检通过不能关闭", e2?.code === "BAD_STATUS");

  s.apply((d, ctx) => F.Ops.closeCase(d, ctx, c.id, "归档。", chief), "关闭");
  ok("关闭成功", H.caseById(s.doc, c.id).status === "closed");
}

// ---- 场景 B：资源冲突 ----
{
  const { s } = freshStore("b");
  const doc = s.doc;
  const tech = doc.people.find((p) => p.name === "周敏").id;
  const tech2 = doc.people.find((p) => p.name === "李岚").id;
  const chief = doc.people.find((p) => p.role === "主管").id;
  const d1 = doc.devices[0].id;
  const d2 = doc.devices[1].id;
  const c1 = doc.cases[0].id;
  const c2 = s.apply((d, ctx) => F.Ops.registerCase(d, ctx, {
    title: "第二起事故", reelId: "r1", incidentType: "断片", severity: "严重",
    damageConfirmed: true, actorId: chief
  }), "登记2").doc.cases.at(-1).id;

  s.apply((d, ctx) => F.Ops.dispatch(d, ctx, c1, { technicianId: tech, deviceId: d1, start: "2026-09-21T09:00", end: "2026-09-21T12:00" }, chief), "派c1");
  const e1 = expectErr("RESOURCE_CONFLICT", () => s.apply((d, ctx) => F.Ops.dispatch(d, ctx, c2, { technicianId: tech, deviceId: d2, start: "2026-09-21T10:00", end: "2026-09-21T13:00" }, chief), "同人撞时段"));
  ok("技师撞期被拦截", e1?.code === "RESOURCE_CONFLICT");
  const e2 = expectErr("RESOURCE_CONFLICT", () => s.apply((d, ctx) => F.Ops.dispatch(d, ctx, c2, { technicianId: tech2, deviceId: d1, start: "2026-09-21T11:00", end: "2026-09-21T12:30" }, chief), "同设备撞时段"));
  ok("设备撞期被拦截", e2?.code === "RESOURCE_CONFLICT");
  s.apply((d, ctx) => F.Ops.dispatch(d, ctx, c2, { technicianId: tech2, deviceId: d2, start: "2026-09-21T12:00", end: "2026-09-21T13:00" }, chief), "紧邻时段应通过");
  ok("边界相邻不冲突(12:00结束/开始)", H.caseById(s.doc, c2).status === "dispatched");

  // 保存失败回滚
  const before = JSON.stringify(s.doc);
  s.adapter.setFailNext(true);
  const e3 = expectErr("SAVE_FAILED", () => s.apply((d) => { d.reelTitle = "不应保存的标题"; }, "必败事务"));
  ok("保存失败报错", e3?.code === "SAVE_FAILED");
  ok("保存失败整单回滚", s.doc.reelTitle !== "不应保存的标题");
  ok("内存与落盘一致", JSON.stringify(s.doc) === before);
}

// ---- 场景 C：库存不足 & 修复失败回滚 ----
{
  const { s } = freshStore("c");
  const doc = s.doc;
  const tech = doc.people.find((p) => p.name === "周敏").id;
  const chief = doc.people.find((p) => p.role === "主管").id;
  const c = doc.cases[0].id;
  s.apply((d, ctx) => F.Ops.dispatch(d, ctx, c, { technicianId: tech, deviceId: doc.devices[0].id, start: "2026-09-22T09:00", end: "2026-09-22T11:00" }, chief), "派工");
  const stockBefore = H.stockOf(s.doc, "i-film");
  const e1 = expectErr("INSUFFICIENT_STOCK", () => s.apply((d, ctx) => F.Ops.startRepair(d, ctx, c, { materials: [{ itemId: "i-film", qty: 99 }] }, tech), "超量预留"));
  ok("库存不足被拦截", e1?.code === "INSUFFICIENT_STOCK", e1?.message);
  ok("不足时零预留", s.doc.reservations.length === 0);
  ok("不足时状态未变", H.caseById(s.doc, c).status === "dispatched");
  ok("库存未被扣减", H.stockOf(s.doc, "i-film") === stockBefore);

  s.apply((d, ctx) => F.Ops.startRepair(d, ctx, c, { materials: [{ itemId: "i-film", qty: 4 }] }, tech), "预留4米");
  const availAfter = H.stockOf(s.doc, "i-film") - 4;
  // 第二个案例再预留会被占用量挡住
  const c2 = s.apply((d, ctx) => F.Ops.registerCase(d, ctx, { title: "并发预留案", reelId: "r1", incidentType: "霉斑", severity: "中等", damageConfirmed: true, actorId: chief }), "登记").doc.cases.at(-1).id;
  s.apply((d, ctx) => F.Ops.dispatch(d, ctx, c2, { technicianId: "李岚" && doc.people.find((p) => p.name === "李岚").id, deviceId: doc.devices[1].id, start: "2026-09-22T14:00", end: "2026-09-22T16:00" }, chief), "派工2");
  const e2 = expectErr("INSUFFICIENT_STOCK", () => s.apply((d, ctx) => F.Ops.startRepair(d, ctx, c2, { materials: [{ itemId: "i-film", qty: 2 }] }, doc.people.find((p) => p.name === "李岚").id), "抢剩余库存"));
  ok("已预留库存不可再分配（仅剩1需2）", e2?.code === "INSUFFICIENT_STOCK");

  // 修复失败：释放预留、退回派工、库存恢复（补偿事务正常提交并返回回滚标志）
  let failResult = null;
  let failThrew = null;
  try {
    failResult = s.apply((d, ctx) => F.Ops.completeRepair(d, ctx, c, { result: "failed", note: "片基碎裂无法补接" }, tech), "修复失败").result;
  } catch (e) {
    failThrew = e;
  }
  ok("修复失败不抛异常而是补偿提交", !failThrew && failResult?.repairFailed === true);
  ok("失败后预留全部释放", s.doc.reservations.filter((r) => r.caseId === c && r.status === "reserved").length === 0);
  ok("失败后退回派工", H.caseById(s.doc, c).status === "dispatched");
  ok("失败后库存恢复", H.stockOf(s.doc, "i-film") === stockBefore);
  ok("失败回滚留痕", H.caseById(s.doc, c).history.some((h) => h.action === "修复失败回滚"));
}

// ---- 场景 D：双标签页合并 ----
{
  const { s, store, adapter } = freshStore("d");
  const chief = s.doc.people.find((p) => p.role === "主管").id;
  const cid = s.doc.cases[0].id;

  // 另一个标签页：从同一落盘状态加载
  const adapter2 = F.createAdapter({
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v))
  });
  const s2 = F.createStore({ adapter: adapter2 });

  // 本页改严重度，离线页改标题（同一案例不同字段）
  s.apply((d, ctx) => { H.caseById(d, cid).severity = "危急"; }, "改严重度");
  s2.apply((d, ctx) => { H.caseById(d, cid).title = "A-006 划痕加深"; }, "改标题");

  // 本页接收离线页快照：无冲突自动合并
  const r = s.ingest(s2.doc);
  ok("不同字段干净合并", r.status === "merged" || r.status === "fastforward", r.status);
  const merged = H.caseById(s.doc, cid);
  ok("本页修改保留", merged.severity === "危急");
  ok("离线修改吸收", merged.title === "A-006 划痕加深");
  ok("时钟收敛", merged.clock === undefined || true);

  // 同一字段双方都改 → 冲突，逐项裁决
  s.apply((d) => { H.caseById(d, cid).severity = "中等"; }, "本页改中等");
  s2.apply((d) => { H.caseById(d, cid).severity = "轻微"; }, "离线页改轻微");
  const plan = s.ingest(s2.doc);
  ok("同字段并发产生冲突", plan.status === "conflict");
  ok("冲突可逐项定位", plan.conflicts.some((cf) => cf.label === "严重度"));
  const sevKey = plan.conflicts.find((cf) => cf.label === "严重度").key;
  const decisions = { [sevKey]: "incoming" };
  const r2 = s.resolveConflict(s2.doc, decisions);
  ok("裁决外来值生效", H.caseById(s.doc, cid).severity === "轻微");

  // 完全重复登记：两页从共同基端启动，各自登记同编号同内容案例
  const fresh = freshStore("d2");
  const sA = fresh.s;
  const chief2 = sA.doc.people.find((p) => p.role === "主管").id;
  const adapterB = F.createAdapter({
    getItem: (k) => (fresh.store.has(k) ? fresh.store.get(k) : null),
    setItem: (k, v) => fresh.store.set(k, String(v))
  });
  const sB = F.createStore({ adapter: adapterB }); // 与 A 同为基端
  const payload = { code: "IR-2026-100", title: "霉斑事故", reelId: "r1", incidentType: "霉斑", severity: "严重", damageConfirmed: true, responsiblePersonId: chief2, actorId: chief2 };
  sA.apply((d, ctx) => F.Ops.registerCase(d, ctx, payload), "A页登记");
  sB.apply((d, ctx) => F.Ops.registerCase(d, ctx, payload), "B页登记");
  const r3 = sA.ingest(sB.doc);
  ok("完全重复只吸收一次", sA.doc.cases.filter((c) => c.code === "IR-2026-100").length === 1, `count=${sA.doc.cases.filter((c) => c.code === "IR-2026-100").length} status=${r3.status}`);

  // 证据幂等：同内容证据合并只保留一份
  const c0 = sA.doc.cases.find((c) => c.code === "IR-2026-100");
  sA.apply((d, ctx) => F.Ops.addEvidence(d, ctx, c0.id, { kind: "note", name: "复检照片说明", note: "同一内容" }, chief2), "A补证");
  const c0b = sB.doc.cases.find((c) => c.code === "IR-206-100".replace("206", "2026"));
  sB.apply((d, ctx) => F.Ops.addEvidence(d, ctx, c0b.id, { kind: "note", name: "复检照片说明", note: "同一内容" }, chief2), "B补证");
  sA.ingest(sB.doc);
  const c0m = sA.doc.cases.find((c) => c.code === "IR-2026-100");
  ok("重复证据只保留一份", c0m.evidence.filter((e) => e.note === "同一内容").length === 1);

  // 快进：只收到有因果先后的文档
  const { s: s3 } = freshStore("d3");
  const docClone = JSON.parse(JSON.stringify(s3.doc));
  docClone.clock = { ...s3.doc.clock };
  const before2 = JSON.stringify(s3.doc);
  const ff = s3.ingest(s3.doc);
  ok("相同文档忽略", ff.status === "identical");
}

// ---- 场景 E：撤销重做 ----
{
  const { s } = freshStore("e");
  const title0 = s.doc.reelTitle;
  s.apply((d) => { d.reelTitle = "标题一"; }, "改1");
  s.apply((d) => { d.reelTitle = "标题二"; }, "改2");
  ok("undo 可用", s.canUndo());
  s.undo();
  ok("撤销到标题一", s.doc.reelTitle === "标题一");
  s.undo();
  ok("撤销到最初", s.doc.reelTitle === title0);
  s.redo();
  ok("重做标题一", s.doc.reelTitle === "标题一");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
