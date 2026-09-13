const { test, expect } = require("@playwright/test");

const APP_KEY = "zfl17-film-rescue-desk-v2";
const UI_KEY = "zfl17-film-rescue-desk-ui";
const OLD_KEY = "zfl17-film-strip-desk";

async function resetAndGoto(page) {
  await page.goto("/index.html");
  await page.evaluate(
    ([a, b, c]) => {
      localStorage.removeItem(a);
      localStorage.removeItem(b);
      sessionStorage.clear();
      localStorage.removeItem(c);
    },
    [APP_KEY, UI_KEY, OLD_KEY]
  );
  await page.reload();
  await expect(page.locator("h1")).toHaveText("胶片抢救任务指挥台");
}

// 在页面内用核心 Ops 准备：登记 → 派工（可选开始修复并预留）
async function prepCase(page, { code, title, tech, device, start, end, reserve }) {
  return page.evaluate(
    ({ code, title, tech, device, start, end, reserve }) => {
      const { store, FR } = window.__RESCUE__;
      const id = (p) => store.doc.people.find((x) => x.name === p).id;
      const dev = (n) => store.doc.devices[n].id;
      const chief = store.doc.people.find((p) => p.role === "主管").id;
      let caseId;
      store.apply((d, ctx) => {
        const c = FR.Ops.registerCase(d, ctx, {
          code,
          title,
          reelId: "r1",
          incidentType: "断片",
          severity: "严重",
          damageConfirmed: true,
          actorId: chief
        });
        caseId = c.id;
        FR.Ops.dispatch(d, ctx, caseId, { technicianId: id(tech), deviceId: dev(device), start, end }, chief);
        if (reserve) {
          FR.Ops.startRepair(d, ctx, caseId, { materials: [{ itemId: "i-film", qty: reserve }] }, id(tech));
        }
      });
      return caseId;
    },
    { code, title, tech, device, start, end, reserve }
  );
}

async function importSnapshotInto(pageA, pageB) {
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

test.describe("离线合并的资源/库存重校验", () => {
  test.beforeEach(async ({ browser }) => {
    // 每个用例独立 context，两个真正离线的标签页
    test.info()._ctx = await browser.newContext();
  });
  test.afterEach(async ({}, testInfo) => {
    await testInfo._ctx.close();
  });

  async function twoPages() {
    const ctx = test.info()._ctx;
    const a = await ctx.newPage();
    const b = await ctx.newPage();
    await resetAndGoto(a);
    await resetAndGoto(b);
    await a.evaluate(() => window.__RESCUE__.setAutoMerge(false));
    await b.evaluate(() => window.__RESCUE__.setAutoMerge(false));
    return { a, b };
  }

  test("技师重叠：同一技师重叠时段双派工，合并被阻止并明确列出", async () => {
    const { a, b } = await twoPages();
    await prepCase(a, { code: "MG-T-A", title: "甲", tech: "周敏", device: 0, start: "2026-11-01T09:00", end: "2026-11-01T12:00" });
    await prepCase(b, { code: "MG-T-B", title: "乙", tech: "周敏", device: 1, start: "2026-11-01T10:00", end: "2026-11-01T13:00" });

    const beforeCount = await a.evaluate(() => window.__RESCUE__.store.doc.cases.length);
    await importSnapshotInto(a, b);

    await expect(a.locator("#mergeMask")).toBeVisible();
    await expect(a.locator("#mergeViolations")).toContainText("技师重叠");
    await expect(a.locator("#mergeViolations")).toContainText("周敏");
    await expect(a.locator("#mergeViolations")).toContainText("MG-T-A");
    await expect(a.locator("#mergeViolations")).toContainText("MG-T-B");
    // 提交被禁用
    await expect(a.locator("#mergeCommit")).toBeDisabled();
    await expect(a.locator("#mergeCommit")).toContainText("无法合并");
    // 本页数据未被写入
    const after = await a.evaluate(() => ({
      count: window.__RESCUE__.store.doc.cases.length,
      hasB: window.__RESCUE__.store.doc.cases.some((c) => c.code === "MG-T-B")
    }));
    expect(after.count).toBe(beforeCount);
    expect(after.hasB).toBe(false);
  });

  test("设备重叠：不同技师但同一设备重叠时段，合并被阻止", async () => {
    const { a, b } = await twoPages();
    await prepCase(a, { code: "MG-D-A", title: "甲", tech: "周敏", device: 0, start: "2026-11-02T09:00", end: "2026-11-02T12:00" });
    await prepCase(b, { code: "MG-D-B", title: "乙", tech: "李岚", device: 0, start: "2026-11-02T11:00", end: "2026-11-02T11:30" });

    await importSnapshotInto(a, b);
    await expect(a.locator("#mergeMask")).toBeVisible();
    await expect(a.locator("#mergeViolations")).toContainText("设备重叠");
    await expect(a.locator("#mergeCommit")).toBeDisabled();
    // 不应误报技师冲突
    await expect(a.locator("#mergeViolations")).not.toContainText("技师重叠");
  });

  test("库存超量：两单各预留4米（库存5米），合并被阻止且可用量不为负", async () => {
    const { a, b } = await twoPages();
    await prepCase(a, { code: "MG-S-A", title: "甲", tech: "周敏", device: 0, start: "2026-11-03T09:00", end: "2026-11-03T10:00", reserve: 4 });
    await prepCase(b, { code: "MG-S-B", title: "乙", tech: "李岚", device: 1, start: "2026-11-03T14:00", end: "2026-11-03T15:00", reserve: 4 });

    const before = await a.evaluate(() => {
      const { store, FR } = window.__RESCUE__;
      return {
        reserved: FR.helpers.reservedQty(store.doc, "i-film"),
        stock: FR.helpers.stockOf(store.doc, "i-film")
      };
    });
    expect(before.reserved).toBe(4);

    await importSnapshotInto(a, b);
    await expect(a.locator("#mergeMask")).toBeVisible();
    await expect(a.locator("#mergeViolations")).toContainText("库存超量");
    await expect(a.locator("#mergeViolations")).toContainText("共预留 8");
    await expect(a.locator("#mergeViolations")).toContainText("缺口 3");
    await expect(a.locator("#mergeCommit")).toBeDisabled();

    // 阻止后本页库存视图不被污染：仍只预留 4，可用 1（非负）
    const after = await a.evaluate(() => {
      const { store, FR } = window.__RESCUE__;
      return {
        reserved: FR.helpers.reservedQty(store.doc, "i-film"),
        available: FR.helpers.stockOf(store.doc, "i-film") - FR.helpers.reservedQty(store.doc, "i-film"),
        hasB: store.doc.cases.some((c) => c.code === "MG-S-B")
      };
    });
    expect(after.reserved).toBe(4);
    expect(after.available).toBe(1);
    expect(after.hasB).toBe(false);
  });

  test("合法合并：时段错开且库存不超，正常合并写入", async () => {
    const { a, b } = await twoPages();
    await prepCase(a, { code: "MG-OK-A", title: "甲", tech: "周敏", device: 0, start: "2026-11-04T09:00", end: "2026-11-04T10:00", reserve: 2 });
    await prepCase(b, { code: "MG-OK-B", title: "乙", tech: "李岚", device: 1, start: "2026-11-04T10:00", end: "2026-11-04T11:00", reserve: 3 });

    await importSnapshotInto(a, b);
    // 无冲突无违规：直接合并成功，不弹裁决框
    await expect(a.locator("#mergeMask")).toBeHidden();
    await expect(a.locator(".toast").last()).toContainText("无冲突合并");

    const result = await a.evaluate(() => {
      const { store, FR } = window.__RESCUE__;
      return {
        both: ["MG-OK-A", "MG-OK-B"].every((code) => store.doc.cases.some((c) => c.code === code)),
        reserved: FR.helpers.reservedQty(store.doc, "i-film"),
        available: FR.helpers.stockOf(store.doc, "i-film") - FR.helpers.reservedQty(store.doc, "i-film")
      };
    });
    expect(result.both).toBe(true);
    expect(result.reserved).toBe(5); // 2 + 3 恰好用完库存
    expect(result.available).toBe(0);
  });

  test("原有闭环不回退：登记→派工→修复→复检→关闭全流程仍可用", async () => {
    const page = (await test.info()._ctx.newPage());
    await resetAndGoto(page);
    await page.fill("#caseTitle", "合并加固后回归-闭环");
    await page.selectOption("#caseSeverity", "严重");
    await page.selectOption("#caseType", "断片");
    await page.fill("#caseEvidenceNote", "初检记录。");
    await page.check("#caseDamageConfirmed");
    await page.click("#caseForm button.primary");
    const code = (await page.locator("#drawerCode").textContent()).trim();

    await page.selectOption("#caseDrawer select[name=technicianId]", { label: "周敏" });
    await page.fill("#caseDrawer input[name=start]", "2026-12-01T09:00");
    await page.fill("#caseDrawer input[name=end]", "2026-12-01T11:00");
    await page.click('[data-form=dispatch] button[type=submit]');
    await expect(page.locator(".toast").last()).toContainText("派工成功");

    await page.click("button[data-action=add-material]");
    await page.locator(".material-row select").selectOption("i-tape");
    await page.locator(".material-row input[type=number]").fill("1");
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
  });
});
