const { test, expect } = require("@playwright/test");

const APP_KEY = "zfl17-film-rescue-desk-v2";
const UI_KEY = "zfl17-film-rescue-desk-ui";
const OLD_KEY = "zfl17-film-strip-desk";

async function freshPage(page) {
  await page.goto("/index.html");
  await page.evaluate(
    ([a, b, c]) => {
      localStorage.removeItem(a);
      localStorage.removeItem(b);
      localStorage.removeItem(c);
    },
    [APP_KEY, UI_KEY, OLD_KEY]
  );
  await page.reload();
  await expect(page.locator("h1")).toHaveText("胶片抢救任务指挥台");
}

async function actorName(page) {
  return page.locator("#actorSelect option").first().textContent();
}

async function selectActorByRole(page, role) {
  await page.evaluate((role) => {
    const sel = document.querySelector("#actorSelect");
    const opt = [...sel.options].find((o) => o.textContent.includes(role));
    if (opt) sel.value = opt.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, role);
}

async function selectActorByName(page, name) {
  await page.evaluate((name) => {
    const sel = document.querySelector("#actorSelect");
    const opt = [...sel.options].find((o) => o.textContent.startsWith(name));
    sel.value = opt.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, name);
}

async function toastText(page) {
  return page.locator(".toast").last().textContent();
}

async function cardByCode(page, code) {
  return page.locator(`.case-card`, { hasText: code }).first();
}

async function registerCase(page, { title, severity = "严重", type = "断片", confirmDamage = true, evidence = true }) {
  // 关闭可能仍打开的抽屉，避免遮罩盖住登记表单
  if (await page.locator("#caseDrawer:not(.hidden)").count()) {
    await page.click("#drawerClose");
    await page.locator("#drawerMask").waitFor({ state: "hidden" });
  }
  await page.fill("#caseTitle", title);
  await page.selectOption("#caseSeverity", severity);
  await page.selectOption("#caseType", type);
  if (evidence) await page.fill("#caseEvidenceNote", "初检：已发现明确损坏。");
  if (confirmDamage) await page.check("#caseDamageConfirmed");
  await page.click("#caseForm button.primary");
  await expect(page.locator(".toast").last()).toContainText("案例已登记");
}

async function fillDispatchForm(page, { tech = "周敏", device = 0, start, end }) {
  await page.selectOption("#caseDrawer select[name=technicianId]", { label: `${tech}` });
  const deviceOpts = page.locator("#caseDrawer select[name=deviceId] option");
  const deviceLabel = await deviceOpts.nth(device + 1).textContent();
  await page.selectOption("#caseDrawer select[name=deviceId]", { label: deviceLabel.trim() });
  if (start) await page.fill("#caseDrawer input[name=start]", start);
  if (end) await page.fill("#caseDrawer input[name=end]", end);
}

async function dispatchCurrent(page, opts) {
  await fillDispatchForm(page, opts);
  await page.click("#caseDrawer button:has-text('派工')");
  await expect(page.locator(".toast").last()).toContainText("派工成功");
}

async function startRepairWith(page, rows) {
  // rows: [{value: "i-tape", qty: 2}]；空数组表示无用料直接开始
  for (let i = 0; i < rows.length; i++) {
    await page.click("button[data-action=add-material]");
  }
  const lines = page.locator(".material-row");
  for (let i = 0; i < rows.length; i++) {
    const row = lines.nth(i);
    await row.locator("select").selectOption(rows[i].value);
    await row.locator("input[type=number]").fill(String(rows[i].qty));
  }
  await page.click("#caseDrawer button:has-text('校验资源并预留库存')");
}

// ============================================================
test.describe("胶片抢救任务指挥台", () => {
  test.beforeEach(async ({ page }) => {
    await freshPage(page);
  });

  // 1) 正常闭环
  test("正常闭环：登记→派工→修复→复检→关闭", async ({ page }) => {
    await registerCase(page, { title: "闭环测试-齿孔撕裂", severity: "严重" });
    // 抽屉自动打开
    await expect(page.locator("#drawerTitle")).toHaveText("闭环测试-齿孔撕裂");
    const code = (await page.locator("#drawerCode").textContent()).trim();

    await dispatchCurrent(page, { tech: "周敏", start: "2026-10-01T09:00", end: "2026-10-01T11:00" });
    await expect(page.locator("#kanban").locator(".col-dispatched")).toContainText(code);

    // 开始修复，预留 2 卷接片胶纸
    await startRepairWith(page, [{ value: "i-tape", qty: 2 }]);
    await expect(page.locator(".toast").last()).toContainText("开始修复");
    await expect(page.locator("#kanban").locator(".col-repairing")).toContainText(code);

    // 库存面板显示预留
    await page.click("#drawerClose");
    await page.click(".tab[data-tab=resources]");
    const invRow = page.locator("#inventoryList .inventory-row", { hasText: "接片胶纸" });
    await expect(invRow).toContainText("预留 2");
    await page.click(".tab[data-tab=board]");

    // 重新打开卡片
    await (await cardByCode(page, code)).click();
    await page.fill("[data-form=complete-repair] [name=note]", "重新压接齿孔，抛光完成。");
    await page.click("#caseDrawer button:has-text('修复成功')");
    await expect(page.locator(".toast").last()).toContainText("修复完成");
    await expect(page.locator("#kanban").locator(".col-reviewing")).toContainText(code);

    // 修复人本人点复检 —— 按钮禁用；切换为复检员陈拓
    await expect(page.locator("#caseDrawer button[value=passed]")).toBeDisabled();
    await selectActorByName(page, "陈拓");
    await page.fill("[data-form=review] [name=note]", "齿孔与画面复检合格。");
    await page.click("#caseDrawer button:has-text('复检通过')");
    await expect(page.locator(".toast").last()).toContainText("复检通过");

    // 关闭（复检通过后抽屉仍开着，直接关闭）
    await expect(page.locator("#caseDrawer")).toContainText("关闭并归档");
    await page.fill("[data-form=close] [name=note]", "资料齐全，归档。");
    await page.click("#caseDrawer button:has-text('关闭并归档')");
    await expect(page.locator(".toast").last()).toContainText("案例已关闭");
    await expect(page.locator("#kanban").locator(".col-closed")).toContainText(code);
    await expect(page.locator("#kanban").locator(".col-reviewing")).not.toContainText(code);

    // 已关闭案例的历史完整
    await page.click("#drawerClose");
    await (await cardByCode(page, code)).click();
    const history = page.locator(".history-list");
    for (const action of ["登记", "派工", "开始修复", "完成修复", "复检通过", "关闭"]) {
      await expect(history).toContainText(action);
    }
  });

  // 2) 越权复检（修复人与复检人不能同一人）
  test("越权复检：修复人本人提交复检被拦截", async ({ page }) => {
    await registerCase(page, { title: "分权测试-霉斑" });
    const code = await page.locator("#drawerCode").textContent();
    await dispatchCurrent(page, { tech: "李岚", device: 1, start: "2026-10-02T09:00", end: "2026-10-02T10:00" });
    // 以被派工技师李岚的身份执行修复
    await selectActorByName(page, "李岚");
    await startRepairWith(page, []);
    await expect(page.locator(".toast").last()).toContainText("开始修复");

    await page.fill("[data-form=complete-repair] [name=note]", "清洁完成。");
    await page.click("#caseDrawer button:has-text('修复成功')");

    // 当前操作员仍是修复人李岚：复检按钮必须禁用
    await expect(page.locator("#caseDrawer")).toContainText("复检人与修复人不能为同一人");
    await expect(page.locator("#caseDrawer button[value=passed]")).toBeDisabled();
    await expect(page.locator("#caseDrawer button[value=failed]")).toBeDisabled();

    // 强行通过 store 调用也必须被核心规则拒绝
    const msg = await page.evaluate(() => {
      const { store, FR } = window.__RESCUE__;
      const c = store.doc.cases.find((x) => x.title === "分权测试-霉斑");
      const repairer = c.repair.repairedBy;
      try {
        store.apply((d, ctx) => FR.Ops.review(d, ctx, c.id, { result: "passed", note: "自批" }, repairer));
        return null;
      } catch (e) {
        return e.message;
      }
    });
    expect(msg).toContain("越权复检被拦截");

    // 状态仍是待复检
    const state = await page.evaluate(() =>
      window.__RESCUE__.store.doc.cases.find((x) => x.title === "分权测试-霉斑").status
    );
    expect(state).toBe("reviewing");
  });

  // 3) 资源冲突（技师 & 设备时段占用）
  test("资源冲突：同一技师/设备时段重叠不能派工", async ({ page }) => {
    await registerCase(page, { title: "资源冲突-案例甲" });
    const codeA = (await page.locator("#drawerCode").textContent()).trim();
    await dispatchCurrent(page, { tech: "周敏", device: 0, start: "2026-10-03T09:00", end: "2026-10-03T12:00" });

    await registerCase(page, { title: "资源冲突-案例乙" });
    const codeB = (await page.locator("#drawerCode").textContent()).trim();
    // 同一技师、不同设备、时间重叠 —— 直接填表提交（成功时按钮是“确认派工”）
    await fillDispatchForm(page, { tech: "周敏", device: 1, start: "2026-10-03T10:00", end: "2026-10-03T13:00" });
    await page.click('[data-form=dispatch] button[type=submit]');
    await expect(page.locator(".toast.error").last()).toContainText("资源冲突");
    // 派工未生效：乙仍在“登记”列
    await expect(page.locator(".kanban-col.col-registered")).toContainText(codeB);

    // 换技师但设备与甲重叠 —— 同样拦截（甲占用的是第 1 台设备 d-u1）
    await page.selectOption("#caseDrawer select[name=technicianId]", { label: "李岚" });
    await page.selectOption("#caseDrawer select[name=deviceId]", { index: 0 });
    await page.fill("#caseDrawer input[name=start]", "2026-10-03T11:00");
    await page.fill("#caseDrawer input[name=end]", "2026-10-03T11:30");
    await page.click('[data-form=dispatch] button[type=submit]');
    await expect(page.locator(".toast.error").last()).toContainText("资源冲突");

    // 紧邻不重叠（12:00 开始）应成功
    await page.fill("#caseDrawer input[name=start]", "2026-10-03T12:00");
    await page.fill("#caseDrawer input[name=end]", "2026-10-03T13:00");
    await page.click('[data-form=dispatch] button[type=submit]');
    await expect(page.locator(".toast.ok").last()).toContainText("派工成功");
    await expect(page.locator(".kanban-col.col-dispatched")).toContainText(codeB);
    expect(codeA).not.toBe(codeB);
  });

  // 4) 库存不足 + 修复失败整单回滚
  test("库存不足无法预留；修复失败释放预留并退回派工", async ({ page }) => {
    await registerCase(page, { title: "库存测试-断片" });
    const code = (await page.locator("#drawerCode").textContent()).trim();
    await dispatchCurrent(page, { tech: "周敏", device: 0, start: "2026-10-04T09:00", end: "2026-10-04T12:00" });

    const stockBefore = await page.evaluate(() => {
      const { store, FR } = window.__RESCUE__;
      return FR.helpers.stockOf(store.doc, "i-film");
    });

    // 超量预留（补条库存仅 5 米）
    await page.click("button[data-action=add-material]");
    const lines = page.locator(".material-row");
    await lines.first().locator("select").selectOption("i-film");
    await lines.first().locator("input[type=number]").fill("99");
    await page.click("#caseDrawer button:has-text('校验资源并预留库存')");
    await expect(page.locator(".toast").last()).toContainText("库存不足");

    // 无任何预留产生，状态仍为派工
    const after = await page.evaluate(() => {
      const { store, FR } = window.__RESCUE__;
      const c = store.doc.cases.find((x) => x.title === "库存测试-断片");
      return {
        reservations: store.doc.reservations.filter((r) => r.caseId === c.id && r.status === "reserved").length,
        status: c.status,
        stock: FR.helpers.stockOf(store.doc, "i-film")
      };
    });
    expect(after.reservations).toBe(0);
    expect(after.status).toBe("dispatched");
    expect(after.stock).toBe(stockBefore);

    // 正常预留 4 米后开始修复
    await lines.first().locator("input[type=number]").fill("4");
    await page.click("#caseDrawer button:has-text('校验资源并预留库存')");
    await expect(page.locator(".toast").last()).toContainText("开始修复");

    // 修复失败 → 整单回滚（抽屉仍打开，直接在表单内操作）
    await page.fill("[data-form=complete-repair] [name=note]", "片基脆化碎裂，无法补接。");
    await page.click("#caseDrawer button:has-text('整单回滚')");
    await expect(page.locator(".toast").last()).toContainText("修复失败：已整单回滚");

    const rolled = await page.evaluate(() => {
      const { store, FR } = window.__RESCUE__;
      const c = store.doc.cases.find((x) => x.title === "库存测试-断片");
      return {
        status: c.status,
        reserved: store.doc.reservations.filter((r) => r.caseId === c.id && r.status === "reserved").length,
        stock: FR.helpers.stockOf(store.doc, "i-film"),
        rollbackLogged: c.history.some((h) => h.action === "修复失败回滚")
      };
    });
    expect(rolled.status).toBe("dispatched");
    expect(rolled.reserved).toBe(0);
    expect(rolled.stock).toBe(stockBefore);
    expect(rolled.rollbackLogged).toBe(true);
  });

  // 5) 保存失败：整单回滚、现场不变
  test("保存失败：故障注入后事务整单回滚", async ({ page }) => {
    await page.click("#failNextBtn");
    await expect(page.locator(".toast").last()).toContainText("下一次保存将失败");

    const titleBefore = await page.evaluate(() => window.__RESCUE__.store.doc.reelTitle);
    await page.click(".tab[data-tab=check]");
    await page.fill("#reelTitle", "不可能落盘的标题");
    await page.waitForTimeout(150);
    await expect(page.locator(".toast").last()).toContainText("保存失败");

    const after = await page.evaluate(() => window.__RESCUE__.store.doc.reelTitle);
    expect(after).toBe(titleBefore);

    // 落盘内容也未被污染
    const persisted = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).doc.reelTitle, APP_KEY);
    expect(persisted).toBe(titleBefore);

    // 后续操作仍正常（故障只作用一次）；先回到看板页签
    await page.click(".tab[data-tab=board]");
    await registerCase(page, { title: "保存失败后仍可登记" });
    await expect(page.locator("#drawerTitle")).toHaveText("保存失败后仍可登记");
  });

  // 6) 双页竞争：实时自动合并 + 离线快照逐项裁决 + 完全重复只吸收一次
  test("双页竞争：同字段冲突逐项裁决，完全重复只吸收一次", async ({ browser }) => {
    const ctx = await browser.newContext();
    const pageA = await ctx.newPage();
    const pageB = await ctx.newPage();
    await pageA.goto("/index.html");
    await pageA.evaluate(([a, b]) => [localStorage.removeItem(a), localStorage.removeItem(b)], [APP_KEY, UI_KEY]);
    await pageA.reload();
    await pageB.goto("/index.html");
    // 两个标签页都先离线：不自动接收对端修改，制造真正的并发分叉
    await pageA.evaluate(() => window.__RESCUE__.setAutoMerge(false));
    await pageB.evaluate(() => window.__RESCUE__.setAutoMerge(false));

    // 两页从同一基端各自登记同编号但内容不同的案例
    const code = "IR-2026-099";
    for (const [pg, payload] of [
      [pageA, { title: "双页竞争-A页标题", severity: "严重" }],
      [pageB, { title: "双页竞争-B页标题", severity: "危急" }]
    ]) {
      await pg.fill("#caseCode", code);
      await pg.fill("#caseTitle", payload.title);
      await pg.selectOption("#caseSeverity", payload.severity);
      await pg.selectOption("#caseType", "霉斑");
      await pg.check("#caseDamageConfirmed");
      await pg.fill("#caseEvidenceNote", "共同的初检记录");
      await pg.click("#caseForm button.primary");
      await pg.locator("#drawerClose").click();
    }

    // A 页通过“合并页面”导入 B 的离线快照
    const snap = await pageB.evaluate(() => window.__RESCUE__.store.exportSnapshot());
    const result = await pageA.evaluate((snap) => {
      const { store } = window.__RESCUE__;
      return store.ingest(snap.doc);
    }, snap);
    expect(result.status).toBe("conflict");

    // UI 层面用文件导入走完整合并中心
    await pageA.evaluate((snap) => {
      const blob = new Blob([JSON.stringify(snap)], { type: "application/json" });
      const file = new File([blob], "snap.json", { type: "application/json" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector("#importSnapshotFile");
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, snap);

    await expect(pageA.locator("#mergeMask")).toBeVisible();
    // 至少两项冲突：重复登记二选一 + 字段冲突（标题/严重度）
    const rows = pageA.locator(".conflict-row");
    await expect(rows.first()).toContainText("重复登记的案例");

    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // 默认全选本页；勾选“一律采用离线页”
    await pageA.check("#mergeTakeIncomingAll");
    await pageA.click("#mergeCommit");
    await expect(pageA.locator(".toast").last()).toContainText("合并完成");

    const merged = await pageA.evaluate((code) => {
      const c = window.__RESCUE__.store.doc.cases.filter((x) => x.code === code);
      return { count: c.length, title: c[0]?.title, severity: c[0]?.severity, id: c[0]?.id };
    }, code);
    expect(merged.count).toBe(1); // 同编号案例只保留一个
    expect(merged.title).toBe("双页竞争-B页标题");
    expect(merged.severity).toBe("危急");
    const bid = await pageB.evaluate((code) => window.__RESCUE__.store.doc.cases.find((x) => x.code === code).id, code);
    expect(merged.id).toBe(bid); // 采用离线页那份登记

    // 完全重复的证据只吸收一次
    const evCount = await pageA.evaluate((code) => {
      const c = window.__RESCUE__.store.doc.cases.find((x) => x.code === code);
      return c.evidence.filter((e) => e.note === "共同的初检记录").length;
    }, code);
    expect(evCount).toBe(1);

    // 实时合并：恢复自动接收；先让 B 快进到 A 的合并结果，再演示协作
    await pageA.evaluate(() => window.__RESCUE__.setAutoMerge(true));
    await pageB.evaluate(() => window.__RESCUE__.setAutoMerge(true));
    await expect(pageB.locator(".case-card", { hasText: "双页竞争-B页标题" })).toBeVisible({ timeout: 6000 });

    // B 页新增案例应通过 storage 事件自动到达 A 页
    await pageB.fill("#caseTitle", "B页独有-新增案例");
    await pageB.click("#caseForm button.primary");
    await pageB.locator("#drawerClose").click();
    await expect(pageA.locator(".case-card", { hasText: "B页独有-新增案例" })).toBeVisible({ timeout: 6000 });

    // 不同字段并发修改（A 改描述、B 改责任人）→ 通过 store 状态轮询验证自动干净合并
    await pageA.evaluate((code) => {
      window.__RESCUE__.store.apply((d) => {
        d.cases.find((x) => x.code === code).description = "A页补充的描述";
      });
    }, code);
    await expect
      .poll(
        async () =>
          pageB.evaluate((code) => {
            const c = window.__RESCUE__.store.doc.cases.find((x) => x.code === code);
            return c?.description || "";
          }, code),
        { timeout: 8000 }
      )
      .toBe("A页补充的描述");
    await pageB.evaluate((code) => {
      window.__RESCUE__.store.apply((d) => {
        d.cases.find((x) => x.code === code).responsiblePersonId = d.people.find((p) => p.role === "主管").id;
      });
    }, code);
    await expect
      .poll(
        async () =>
          pageA.evaluate((code) => {
            const c = window.__RESCUE__.store.doc.cases.find((x) => x.code === code);
            return { desc: c?.description, resp: !!c?.responsiblePersonId };
          }, code),
        { timeout: 8000 }
      )
      .toEqual({ desc: "A页补充的描述", resp: true });

    await ctx.close();
  });

  // 7) 刷新保留现场 + 撤销重做 + 导出事故包 + 缺证据/未确认不能关闭
  test("刷新保留现场、撤销重做、导出事故包、关闭前置校验", async ({ page }) => {
    // 登记一个不确认损坏、也无证据的案例
    await page.fill("#caseTitle", "现场保留测试");
    await page.selectOption("#caseSeverity", { label: "中等" });
    await page.fill("#caseDesc", "写到一半的描述");
    // 不勾损坏确认、不填证据，直接刷新 —— 表单草稿应保留
    await page.fill("#boardSearch", "现场");
    await page.click(".tab[data-tab=resources]");

    await page.reload();
    await expect(page.locator("#caseTitle")).toHaveValue("现场保留测试");
    await expect(page.locator("#caseDesc")).toHaveValue("写到一半的描述");
    await expect(page.locator("#boardSearch")).toHaveValue("现场");
    await expect(page.locator(".tab.active")).toHaveText("资源与库存");

    // 回到看板正式登记（补齐证据但不确认损坏）
    await page.click(".tab[data-tab=board]");
    await page.fill("#caseEvidenceNote", "仅有证据，损坏未确认");
    await page.click("#caseForm button.primary");
    const code = (await page.locator("#drawerCode").textContent()).trim();
    // 直接推到复检通过（核心流程），用于验证关闭门槛
    const blockers = await page.evaluate((code) => {
      const { store, FR } = window.__RESCUE__;
      const c = store.doc.cases.find((x) => x.code === code);
      const chief = store.doc.people.find((p) => p.role === "主管").id;
      const tech = store.doc.people.find((p) => p.role === "修复技师").id;
      const reviewer = store.doc.people.find((p) => p.role === "复检员").id;
      const device = store.doc.devices[0].id;
      const errors = [];
      const run = (fn) => {
        try { store.apply(fn); } catch (e) { errors.push(e.message); }
      };
      run((d, ctx) => FR.Ops.dispatch(d, ctx, c.id, { technicianId: tech, deviceId: device, start: "2026-10-05T09:00", end: "2026-10-05T10:00" }, chief));
      run((d, ctx) => FR.Ops.startRepair(d, ctx, c.id, { materials: [] }, tech));
      run((d, ctx) => FR.Ops.completeRepair(d, ctx, c.id, { result: "success", note: "修复" }, tech));
      run((d, ctx) => FR.Ops.review(d, ctx, c.id, { result: "passed", note: "复检" }, reviewer));
      run((d, ctx) => FR.Ops.closeCase(d, ctx, c.id, "", chief));
      return { errors, status: store.doc.cases.find((x) => x.code === code).status };
    }, code);
    expect(blockers.errors.join(" ")).toContain("损坏情况尚未经责任人确认");
    expect(blockers.status).toBe("approved"); // 没关掉

    // 缺证据拦截：另一个已确认损坏但无证据的案例
    await page.locator("#drawerClose").click();
    await page.fill("#caseTitle", "无证据案例");
    await page.check("#caseDamageConfirmed");
    // 清空证据输入（默认无）
    await page.click("#caseForm button.primary");
    const code2 = (await page.locator("#drawerCode").textContent()).trim();
    const noEv = await page.evaluate((code) => {
      const { store, FR } = window.__RESCUE__;
      const c = store.doc.cases.find((x) => x.code === code);
      const chief = store.doc.people.find((p) => p.role === "主管").id;
      const tech = store.doc.people.find((p) => p.role === "修复技师").id;
      const reviewer = store.doc.people.find((p) => p.role === "复检员").id;
      const errors = [];
      const run = (fn) => { try { store.apply(fn); } catch (e) { errors.push(e.message); } };
      run((d, ctx) => FR.Ops.dispatch(d, ctx, c.id, { technicianId: tech, deviceId: store.doc.devices[1].id, start: "2026-10-06T09:00", end: "2026-10-06T10:00" }, chief));
      run((d, ctx) => FR.Ops.startRepair(d, ctx, c.id, { materials: [] }, tech));
      run((d, ctx) => FR.Ops.completeRepair(d, ctx, c.id, { result: "success", note: "修复" }, tech));
      run((d, ctx) => FR.Ops.review(d, ctx, c.id, { result: "passed", note: "复检" }, reviewer));
      run((d, ctx) => FR.Ops.closeCase(d, ctx, c.id, "", chief));
      return errors.join(" ");
    }, code2);
    expect(noEv).toContain("缺少修复/复检证据");

    // 撤销重做：先关掉抽屉（遮罩会挡住顶栏按钮）
    await page.click("#drawerClose");
    const undoBefore = await page.evaluate((c) => window.__RESCUE__.store.doc.cases.find((x) => x.code === c)?.status, code2);
    expect(undoBefore).toBe("approved");
    await page.click("#undoBtn");
    const undoAfter = await page.evaluate((c) => window.__RESCUE__.store.doc.cases.find((x) => x.code === c)?.status, code2);
    expect(undoAfter).toBe("reviewing");
    await page.click("#redoBtn");
    const redoAfter = await page.evaluate((c) => window.__RESCUE__.store.doc.cases.find((x) => x.code === c)?.status, code2);
    expect(redoAfter).toBe("approved");

    // 导出事故包：选中案例后关闭抽屉（顶栏在抽屉下层），再点顶栏导出
    await (await cardByCode(page, code)).click();
    await expect(page.locator("#drawerCode")).toContainText(code);
    await page.click("#drawerClose");
    const downloadEvent = page.waitForEvent("download");
    await page.click("#exportPackageBtn");
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toContain(code);
    const path = await download.path();
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
    expect(pkg.kind).toBe("film-rescue-incident-package");
    expect(pkg.incident.code).toBe(code);
    expect(pkg.incident.evidence.length).toBeGreaterThan(0);
    expect(pkg.references.reservations).toBeDefined();

    // 刷新后抽屉重新打开同一案例（现场保留）：先重新打开该案例再刷新
    await (await cardByCode(page, code)).click();
    await expect(page.locator("#drawerCode")).toContainText(code);
    await page.reload();
    await expect(page.locator("#caseDrawer")).toBeVisible();
    await expect(page.locator("#drawerCode")).toContainText(code);
  });
});
