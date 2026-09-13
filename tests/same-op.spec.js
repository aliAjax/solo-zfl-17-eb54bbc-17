const { test, expect } = require("@playwright/test");

const APP_KEY = "zfl17-film-rescue-desk-v2";
const UI_KEY = "zfl17-film-rescue-desk-ui";
const OLD_KEY = "zfl17-film-strip-desk";

// 两页共享 localStorage 的“共同基端”：A 登记案例并落盘后，B 再打开加载到同一基端
async function sharedBase(browser) {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  await a.goto("/index.html");
  await a.evaluate(
    ([k1, k2, k3]) => {
      localStorage.removeItem(k1);
      localStorage.removeItem(k2);
      localStorage.removeItem(k3);
      sessionStorage.clear();
    },
    [APP_KEY, UI_KEY, OLD_KEY]
  );
  await a.reload();
  const cid = await a.evaluate(() => {
    const { store, FR } = window.__RESCUE__;
    const chief = store.doc.people.find((p) => p.role === "主管").id;
    let id;
    store.apply((d, ctx2) => {
      id = FR.Ops.registerCase(d, ctx2, {
        code: "SAME-OP-1",
        title: "同案同操作",
        reelId: "r1",
        incidentType: "断片",
        severity: "严重",
        damageConfirmed: true,
        actorId: chief
      }).id;
    });
    return id;
  });
  const b = await ctx.newPage();
  await b.goto("/index.html"); // 加载到含案例的共同基端
  await a.evaluate(() => window.__RESCUE__.setAutoMerge(false));
  await b.evaluate(() => window.__RESCUE__.setAutoMerge(false));
  return { ctx, a, b, cid };
}

// 两页对同一案例执行完全相同的派工 + （可选）相同预留
async function identicalDispatchReserve(page, cid, qty) {
  await page.evaluate(
    ({ cid, qty }) => {
      const { store, FR } = window.__RESCUE__;
      const chief = store.doc.people.find((p) => p.role === "主管").id;
      const tech = store.doc.people.find((p) => p.name === "周敏").id;
      store.apply((d, ctx) => {
        FR.Ops.dispatch(
          d,
          ctx,
          cid,
          { technicianId: tech, deviceId: d.devices[0].id, start: "2026-12-10T09:00", end: "2026-12-10T11:00" },
          chief
        );
        FR.Ops.startRepair(d, ctx, cid, { materials: qty ? [{ itemId: "i-film", qty }] : [] }, tech);
      });
    },
    { cid, qty }
  );
}

async function importSnapshot(pageA, pageB) {
  const snap = await pageB.evaluate(() => window.__RESCUE__.store.exportSnapshot());
  await pageA.evaluate((snap) => {
    const blob = new Blob([JSON.stringify(snap)], { type: "application/json" });
    const file = new File([blob], "snap.json", { type: "application/json" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector("#importSnapshotFile");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, snap);
}

test.describe("同案同操作只吸收一次", () => {
  test("同案相同派工+预留（小数量）：合并后预留与流转记录不翻倍", async ({ browser }) => {
    const { ctx, a, b, cid } = await sharedBase(browser);
    await identicalDispatchReserve(a, cid, 2);
    await identicalDispatchReserve(b, cid, 2);

    await importSnapshot(a, b);

    // 合法合并：不弹裁决/阻止框
    await expect(a.locator("#mergeMask")).toBeHidden();
    const merged = await a.evaluate(
      (cid) => {
        const { store, FR } = window.__RESCUE__;
        const c = FR.helpers.caseById(store.doc, cid);
        return {
          status: c.status,
          reservedFilm: FR.helpers.reservedQty(store.doc, "i-film"),
          caseReservations: store.doc.reservations.filter((r) => r.caseId === cid).length,
          dispatchHistory: c.history.filter((h) => h.action === "派工").length,
          startHistory: c.history.filter((h) => h.action === "开始修复").length,
          bookingCount: c.booking ? 1 : 0
        };
      },
      cid
    );
    expect(merged.reservedFilm).toBe(2); // 不是 4
    expect(merged.caseReservations).toBe(1); // 相同预留只一条
    expect(merged.dispatchHistory).toBe(1); // 派工历史不重复
    expect(merged.startHistory).toBe(1); // 开始修复历史不重复
    expect(merged.bookingCount).toBe(1);
    expect(merged.status).toBe("repairing");

    await ctx.close();
  });

  test("预留量较大（恰等于库存5米）：不误报库存超量、不拒绝合法合并", async ({ browser }) => {
    const { ctx, a, b, cid } = await sharedBase(browser);
    await identicalDispatchReserve(a, cid, 5);
    await identicalDispatchReserve(b, cid, 5);

    await importSnapshot(a, b);

    await expect(a.locator("#mergeMask")).toBeHidden();
    await expect(a.locator(".toast").last()).toContainText("无冲突合并");
    const r = await a.evaluate(
      (cid) => {
        const { store, FR } = window.__RESCUE__;
        const stock = FR.helpers.stockOf(store.doc, "i-film");
        const reserved = FR.helpers.reservedQty(store.doc, "i-film");
        return {
          reserved,
          available: stock - reserved,
          reservations: store.doc.reservations.filter((x) => x.caseId === cid).length
        };
      },
      cid
    );
    expect(r.reserved).toBe(5); // 不是 10，因此不会误判为缺口 5
    expect(r.available).toBe(0); // 恰好合法，不为负
    expect(r.reservations).toBe(1);
    await ctx.close();
  });

  test("确实不同的操作仍合并：相同派工吸收一次，不同材料的两条预留都保留", async ({ browser }) => {
    const { ctx, a, b, cid } = await sharedBase(browser);
    // a：相同派工 + 片基2米；b：相同派工 + 胶纸3卷
    await a.evaluate(
      ({ cid }) => {
        const { store, FR } = window.__RESCUE__;
        const chief = store.doc.people.find((p) => p.role === "主管").id;
        const tech = store.doc.people.find((p) => p.name === "周敏").id;
        store.apply((d, ctx) => {
          FR.Ops.dispatch(d, ctx, cid, { technicianId: tech, deviceId: d.devices[0].id, start: "2026-12-10T09:00", end: "2026-12-10T11:00" }, chief);
          FR.Ops.startRepair(d, ctx, cid, { materials: [{ itemId: "i-film", qty: 2 }] }, tech);
        });
      },
      { cid }
    );
    await b.evaluate(
      ({ cid }) => {
        const { store, FR } = window.__RESCUE__;
        const chief = store.doc.people.find((p) => p.role === "主管").id;
        const tech = store.doc.people.find((p) => p.name === "周敏").id;
        store.apply((d, ctx) => {
          FR.Ops.dispatch(d, ctx, cid, { technicianId: tech, deviceId: d.devices[0].id, start: "2026-12-10T09:00", end: "2026-12-10T11:00" }, chief);
          FR.Ops.startRepair(d, ctx, cid, { materials: [{ itemId: "i-tape", qty: 3 }] }, tech);
        });
      },
      { cid }
    );

    await importSnapshot(a, b);
    await expect(a.locator("#mergeMask")).toBeHidden();

    const r = await a.evaluate((cid) => {
      const { store, FR } = window.__RESCUE__;
      const c = FR.helpers.caseById(store.doc, cid);
      return {
        film: store.doc.reservations.filter((x) => x.caseId === cid && x.itemId === "i-film").length,
        tape: store.doc.reservations.filter((x) => x.caseId === cid && x.itemId === "i-tape").length,
        filmQty: FR.helpers.reservedQty(store.doc, "i-film"),
        tapeQty: FR.helpers.reservedQty(store.doc, "i-tape"),
        dispatchHistory: c.history.filter((h) => h.action === "派工").length,
        startHistory: c.history.filter((h) => h.action === "开始修复").length
      };
    }, cid);
    expect(r.film).toBe(1);
    expect(r.tape).toBe(1);
    expect(r.filmQty).toBe(2);
    expect(r.tapeQty).toBe(3);
    expect(r.dispatchHistory).toBe(1); // 相同派工只一次
    expect(r.startHistory).toBe(2); // 两次用料不同，算两次操作
    await ctx.close();
  });

  test("原有完整闭环不回退：登记→派工→修复→复检→关闭", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/index.html");
    await page.evaluate(
      ([k1, k2, k3]) => {
        localStorage.removeItem(k1);
        localStorage.removeItem(k2);
        localStorage.removeItem(k3);
        sessionStorage.clear();
      },
      [APP_KEY, UI_KEY, OLD_KEY]
    );
    await page.reload();

    await page.fill("#caseTitle", "同操作去重后回归-闭环");
    await page.selectOption("#caseSeverity", "严重");
    await page.selectOption("#caseType", "断片");
    await page.fill("#caseEvidenceNote", "初检记录。");
    await page.check("#caseDamageConfirmed");
    await page.click("#caseForm button.primary");
    const code = (await page.locator("#drawerCode").textContent()).trim();

    await page.selectOption("#caseDrawer select[name=technicianId]", { label: "周敏" });
    await page.fill("#caseDrawer input[name=start]", "2026-12-20T09:00");
    await page.fill("#caseDrawer input[name=end]", "2026-12-20T11:00");
    await page.click('[data-form=dispatch] button[type=submit]');
    await expect(page.locator(".toast").last()).toContainText("派工成功");

    await page.click("button[data-action=add-material]");
    await page.locator(".material-row select").selectOption("i-tape");
    await page.locator(".material-row input[type=number]").fill("2");
    await page.click("#caseDrawer button:has-text('校验资源并预留库存')");
    await expect(page.locator(".toast").last()).toContainText("开始修复");

    await page.fill("[data-form=complete-repair] [name=note]", "修复完成。");
    await page.click("#caseDrawer button:has-text('修复成功')");
    await expect(page.locator(".toast").last()).toContainText("修复完成");

    await page.evaluate(() => {
      const sel = document.querySelector("#actorSelect");
      sel.value = [...sel.options].find((o) => o.textContent.startsWith("陈拓")).value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.fill("[data-form=review] [name=note]", "复检合格。");
    await page.click("#caseDrawer button:has-text('复检通过')");
    await expect(page.locator(".toast").last()).toContainText("复检通过");

    await page.fill("[data-form=close] [name=note]", "归档。");
    await page.click("#caseDrawer button:has-text('关闭并归档')");
    await expect(page.locator(".toast").last()).toContainText("案例已关闭");
    await expect(page.locator(".kanban-col.col-closed")).toContainText(code);
    await ctx.close();
  });
});
