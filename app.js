/* 胶片抢救任务指挥台 —— UI 层 */
(function () {
  "use strict";
  const FR = window.FilmRescue;
  const H = FR.helpers;
  const esc = H.escapeHtml;
  const store = FR.createStore();

  const uiState = loadUiState();
  let mergePlan = null; // 待裁决的离线合并
  let toastSeq = 0;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ---------- 现场持久化（刷新保留） ----------
  function loadUiState() {
    try {
      return JSON.parse(localStorage.getItem(FR.KEYS.UI_KEY)) || {};
    } catch {
      return {};
    }
  }
  function saveUiState(patch) {
    Object.assign(uiState, patch);
    try {
      localStorage.setItem(FR.KEYS.UI_KEY, JSON.stringify(uiState));
    } catch {
      /* 现场保存失败不阻断操作 */
    }
  }

  // ---------- 提示 ----------
  function toast(message, kind = "ok", ms = 4200) {
    const stack = $("#toastStack");
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.dataset.id = ++toastSeq;
    el.innerHTML = `<span>${esc(message)}</span><button type="button" aria-label="关闭">×</button>`;
    el.querySelector("button").addEventListener("click", () => el.remove());
    stack.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function runTx(label, fn, okMsg) {
    try {
      const out = store.apply((draft, ctx) => fn(draft, ctx), label);
      if (okMsg) toast(okMsg, "ok");
      if (out.result?.repairFailed) toast(out.result.message, "warn", 7000);
      return out;
    } catch (err) {
      toast(err.message || String(err), "error", 7000);
      return null;
    }
  }

  const actorId = () => $("#actorSelect").value;

  // ---------- 选项填充 ----------
  function fillSelect(select, options, { empty, getVal = (o) => o.id, getLabel = (o) => o.name } = {}) {
    const current = select.value;
    select.innerHTML =
      (empty ? `<option value="">${esc(empty)}</option>` : "") +
      options.map((o) => `<option value="${esc(getVal(o))}">${esc(getLabel(o))}</option>`).join("");
    if ([...select.options].some((o) => o.value === current)) select.value = current;
  }

  function renderActorSelect() {
    const sel = $("#actorSelect");
    sel.innerHTML = store.doc.people
      .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}（${esc(p.role)}）</option>`)
      .join("");
    sel.value = uiState.actorId && store.doc.people.some((p) => p.id === uiState.actorId)
      ? uiState.actorId
      : store.doc.people[0]?.id || "";
  }

  function renderStaticOptions() {
    fillSelect($("#caseReel"), store.doc.reels);
    fillSelect($("#caseResponsible"), store.doc.people, { empty: "（未指定）" });
    $("#caseSeverity").innerHTML = FR.SEVERITIES.map((s) => `<option>${s}</option>`).join("");
    $("#caseType").innerHTML = FR.INCIDENT_TYPES.map((t) => `<option>${t}</option>`).join("");
    $("#boardSeverityFilter").innerHTML =
      `<option value="all">全部严重度</option>` + FR.SEVERITIES.map((s) => `<option>${s}</option>`).join("");
    fillSelect($("#boardReelFilter"), store.doc.reels, { getVal: (r) => r.id, getLabel: (r) => r.name });
    fillSelect($("#segmentReel"), store.doc.reels);
    renderSegmentCheckboxes();
  }

  function renderSegmentCheckboxes() {
    const box = $("#caseSegments");
    const chosen = new Set(uiState.caseSegments || []);
    box.innerHTML = store.doc.segments
      .map((s) => {
        const checked = chosen.has(s.id) ? "checked" : "";
        return `<label class="chip-check"><input type="checkbox" value="${esc(s.id)}" ${checked}/>${esc(s.code)}</label>`;
      })
      .join("") || `<span class="muted">暂无片段</span>`;
  }

  // ---------- 统计 ----------
  function renderStats() {
    const d = store.doc;
    const active = d.cases.filter((c) => c.status !== "closed");
    const totalDuration = d.segments.reduce((s, x) => s + Number(x.duration || 0), 0);
    const cards = [
      ["在办事故", active.length],
      ["危急/严重", d.cases.filter((c) => ["危急", "严重"].includes(c.severity) && c.status !== "closed").length],
      ["修复中", d.cases.filter((c) => c.status === "repairing").length],
      ["待复检", d.cases.filter((c) => c.status === "reviewing" || c.status === "approved").length],
      ["片段数", d.segments.length],
      ["总时长", fmtDuration(totalDuration)]
    ];
    $("#statsRow").innerHTML = cards
      .map(([k, v]) => `<div class="stat-card"><span>${k}</span><strong>${esc(v)}</strong></div>`)
      .join("");
  }

  function fmtDuration(seconds) {
    const v = Number(seconds) || 0;
    return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
  }

  function statusLabel(c) {
    if (c.status === "approved") return "待关闭";
    return FR.STATUS[c.status];
  }

  // ---------- 看板 ----------
  function filteredCases() {
    const kw = ($("#boardSearch").value || "").trim();
    const sev = $("#boardSeverityFilter").value;
    const reel = $("#boardReelFilter").value;
    return store.doc.cases.filter((c) => {
      if (sev !== "all" && c.severity !== sev) return false;
      if (reel !== "all" && c.reelId !== reel) return false;
      if (kw) {
        const hay = `${c.code}${c.title}${c.incidentType}${(c.segmentCodes || []).join("")}`;
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }

  const COL_META = [
    { key: "registered", title: "① 登记", cls: "col-registered" },
    { key: "dispatched", title: "② 派工", cls: "col-dispatched" },
    { key: "repairing", title: "③ 修复", cls: "col-repairing" },
    { key: "reviewing", title: "④ 复检 / 待关闭", cls: "col-reviewing" },
    { key: "closed", title: "⑤ 关闭", cls: "col-closed" }
  ];

  function columnOf(c) {
    return c.status === "approved" ? "reviewing" : c.status;
  }

  function renderKanban() {
    const list = filteredCases();
    $("#boardCount").textContent = `${list.length} / ${store.doc.cases.length} 个案例`;
    $("#kanban").innerHTML = COL_META.map((col) => {
      const items = list.filter((c) => columnOf(c) === col.key);
      return `
        <div class="kanban-col ${col.cls}">
          <header><h3>${col.title}</h3><span class="count">${items.length}</span></header>
          <div class="kanban-cards">
            ${items.map(kanbanCard).join("") || `<p class="empty-col">无</p>`}
          </div>
        </div>`;
    }).join("");
  }

  function kanbanCard(c) {
    const sevCls = `sev-${{ 轻微: "low", 中等: "mid", 严重: "high", 危急: "crit" }[c.severity] || "low"}`;
    const reel = H.reelById(store.doc, c.reelId)?.name || "";
    const tech = c.booking ? H.personById(store.doc, c.booking.technicianId)?.name : "";
    const evBadge = c.evidence.length ? `${c.evidence.length}份证据` : "缺证据";
    const evCls = c.evidence.length ? "badge-ok" : "badge-bad";
    const confCls = c.damageConfirmed ? "badge-ok" : "badge-bad";
    return `
      <article class="case-card ${sevCls}" data-case="${esc(c.id)}" tabindex="0">
        <div class="card-top">
          <span class="case-no">${esc(c.code)}</span>
          <span class="sev-tag">${esc(c.severity)}</span>
        </div>
        <h4>${esc(c.title)}</h4>
        <p class="card-meta">${esc(reel)} · ${esc(c.incidentType)}${tech ? ` · 技师 ${esc(tech)}` : ""}</p>
        <div class="card-badges">
          <span class="badge ${evCls}">${evBadge}</span>
          <span class="badge ${confCls}">${c.damageConfirmed ? "损坏已确认" : "损坏未确认"}</span>
        </div>
        ${c.status === "approved" ? `<p class="approve-flag">复检通过，可关闭</p>` : ""}
      </article>`;
  }

  // ---------- 案例抽屉 ----------
  function openDrawer(caseId) {
    saveUiState({ openCaseId: caseId, lastCaseId: caseId });
    renderDrawer();
    $("#drawerMask").classList.remove("hidden");
    $("#caseDrawer").classList.remove("hidden");
  }
  function closeDrawer() {
    saveUiState({ openCaseId: null });
    $("#drawerMask").classList.add("hidden");
    $("#caseDrawer").classList.add("hidden");
  }

  function renderDrawer() {
    const id = uiState.openCaseId;
    const c = id && H.caseById(store.doc, id);
    if (!c) {
      closeDrawer();
      return;
    }
    $("#drawerCode").textContent = c.code;
    $("#drawerTitle").textContent = c.title;
    $("#drawerBody").innerHTML = drawerContent(c);
    hydrateDrawerForms(c);
  }

  function personName(pid) {
    return H.personById(store.doc, pid)?.name || "—";
  }
  function ts(iso) {
    return iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "";
  }

  function drawerContent(c) {
    const me = actorId();
    const techs = store.doc.people.filter((p) => p.role === "修复技师");
    const reviewers = store.doc.people.filter((p) => p.role === "复检员" || p.role === "主管");
    const devices = store.doc.devices;
    const held = store.doc.reservations.filter((r) => r.caseId === c.id && r.status === "reserved");
    const isRepairer = c.repair && c.repair.repairedBy === me;

    return `
      <section class="d-section">
        <div class="kv-grid">
          <div><span>胶片卷</span><b>${esc(H.reelById(store.doc, c.reelId)?.name || "—")}</b></div>
          <div><span>事故类型</span><b>${esc(c.incidentType)}</b></div>
          <div><span>严重度</span><b class="sev-${{ 轻微: "low", 中等: "mid", 严重: "high", 危急: "crit" }[c.severity]}">${esc(c.severity)}</b></div>
          <div><span>责任人</span><b>${esc(personName(c.responsiblePersonId))}</b></div>
          <div><span>涉及片段</span><b>${esc((c.segmentCodes || []).join("、") || "—")}</b></div>
          <div><span>当前状态</span><b>${esc(statusLabel(c))}</b></div>
        </div>
        <p class="case-desc">${esc(c.description || "（无描述）")}</p>
      </section>

      <section class="d-section">
        <h3>证据链（${c.evidence.length}）</h3>
        <div class="evidence-list">
          ${c.evidence.map((ev) => `
            <div class="evidence-item">
              ${ev.dataUrl ? `<img src="${ev.dataUrl}" alt="${esc(ev.name)}" />` : `<div class="evidence-ph">${esc(ev.kind)}</div>`}
              <div><b>${esc(ev.name)}</b><p>${esc(ev.note || "")}</p></div>
            </div>`).join("") || `<p class="muted">暂无证据 —— 关闭案例前必须补齐。</p>`}
        </div>
        ${c.status === "closed" ? "" : `
        <form class="evidence-add" data-form="evidence">
          <input type="text" name="name" placeholder="证据名称，如：复检照片" />
          <textarea name="note" rows="2" placeholder="证据说明"></textarea>
          <input type="file" name="file" accept="image/*" />
          <button type="submit">补充证据</button>
        </form>`}
      </section>

      ${damageBlock(c, me)}
      ${dispatchBlock(c, techs, devices)}
      ${repairBlock(c, me, held)}
      ${reviewBlock(c, me, reviewers, isRepairer)}
      ${closeBlock(c)}

      <section class="d-section">
        <h3>流转记录</h3>
        <ol class="history-list">
          ${c.history.map((h) => `
            <li>
              <span class="h-time">${esc(ts(h.ts))}</span>
              <b>${esc(h.action)}</b>
              <span class="h-actor">${esc(personName(h.actorId))}</span>
              <p>${esc(h.detail)}</p>
            </li>`).join("")}
        </ol>
      </section>`;
  }

  function damageBlock(c, me) {
    if (c.damageConfirmed || c.status === "closed") return "";
    return `
      <section class="d-section action-box warn-box">
        <h3>损坏确认</h3>
        <p class="muted">关闭前必须由责任人确认损坏情况。</p>
        <button type="button" data-action="confirm-damage">责任人现场确认损坏</button>
      </section>`;
  }

  function dispatchBlock(c, techs, devices) {
    if (!["registered", "dispatched"].includes(c.status)) return "";
    const b = c.booking;
    return `
      <section class="d-section action-box">
        <h3>${b ? "改派 / 重新派工" : "派工"}</h3>
        ${b ? `<p class="muted">当前：${esc(personName(b.technicianId))} · ${esc(H.deviceById(store.doc, b.deviceId)?.name)} · ${esc(b.start.replace("T", " "))} ~ ${esc(b.end.replace("T", " "))}</p>` : ""}
        <form data-form="dispatch" class="grid-form">
          <label>修复技师
            <select name="technicianId" required>
              ${techs.map((t) => `<option value="${t.id}" ${b && b.technicianId === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
            </select>
          </label>
          <label>修复设备
            <select name="deviceId" required>
              ${devices.map((d) => `<option value="${d.id}" ${b && b.deviceId === d.id ? "selected" : ""}>${esc(d.name)}</option>`).join("")}
            </select>
          </label>
          <label>开始
            <input type="datetime-local" name="start" required value="${esc(b?.start || defaultStart())}" />
          </label>
          <label>结束
            <input type="datetime-local" name="end" required value="${esc(b?.end || defaultEnd())}" />
          </label>
          <button type="submit">${b ? "重新派工" : "确认派工"}</button>
        </form>
      </section>`;
  }

  function repairBlock(c, me, held) {
    if (!["dispatched", "repairing"].includes(c.status)) {
      if (c.repair) {
        return `
          <section class="d-section done-box">
            <h3>修复记录</h3>
            <p>修复人：<b>${esc(personName(c.repair.repairedBy))}</b> · ${esc(ts(c.repair.ts))}</p>
            <p>${esc(c.repair.note)}</p>
            ${c.repair.materials?.length ? `<p class="muted">用料：${esc(c.repair.materials.map((m) => `${H.itemById(store.doc, m.itemId)?.name}×${m.qty}`).join("、"))}</p>` : ""}
          </section>`;
      }
      return "";
    }
    if (c.status === "dispatched") {
      return `
        <section class="d-section action-box">
          <h3>开始修复（先预留库存）</h3>
          <form data-form="start-repair" class="grid-form">
            <div class="material-lines" data-material-lines></div>
            <button type="button" data-action="add-material">+ 添加用料 / 替换片段</button>
            <button type="submit" class="primary">校验资源并预留库存、开始修复</button>
          </form>
        </section>`;
    }
    // repairing
    return `
      <section class="d-section action-box">
        <h3>修复作业中</h3>
        <p class="muted">已预留：${held.length ? esc(held.map((r) => `${H.itemById(store.doc, r.itemId)?.name}×${r.qty}`).join("、")) : "无用料"}</p>
        <form data-form="complete-repair" class="grid-form">
          ${c.segmentCodes.length ? `
          <label>替换片段（可选）
            <input type="text" name="replacementSegmentCode" placeholder="替换片段编号" />
          </label>` : ""}
          <label>修复记录
            <textarea name="note" rows="3" required placeholder="修复措施、替换/补接情况"></textarea>
          </label>
          <div class="btn-row">
            <button type="submit" name="result" value="success" class="primary">修复成功，提交复检</button>
            <button type="submit" name="result" value="failed" class="danger">修复失败，整单回滚</button>
          </div>
        </form>
      </section>`;
  }

  function reviewBlock(c, me, reviewers, isRepairer) {
    if (c.status !== "reviewing" && c.status !== "approved") {
      if (c.review) {
        return `
          <section class="d-section done-box ${c.review.result === "failed" ? "warn-box" : ""}">
            <h3>复检记录</h3>
            <p>复检人：<b>${esc(personName(c.review.reviewedBy))}</b> · ${c.review.result === "passed" ? "通过" : "不通过"} · ${esc(ts(c.review.ts))}</p>
            <p>${esc(c.review.note)}</p>
          </section>`;
      }
      return "";
    }
    if (c.status === "approved") {
      return `
        <section class="d-section done-box">
          <h3>复检已通过</h3>
          <p>复检人：<b>${esc(personName(c.review.reviewedBy))}</b> · ${esc(ts(c.review.ts))}</p>
          <p>${esc(c.review.note)}</p>
        </section>`;
    }
    const repairerName = personName(c.repair?.repairedBy);
    return `
      <section class="d-section action-box ${isRepairer ? "locked-box" : ""}">
        <h3>复检</h3>
        <p class="muted ${isRepairer ? "lock-warn" : ""}">修复人：${esc(repairerName)}。复检人与修复人不能为同一人。</p>
        <form data-form="review" class="grid-form">
          <label>复检意见（必填）
            <textarea name="note" rows="3" required placeholder="画面、齿孔、接片位置复检结论"></textarea>
          </label>
          <label>复检证据（可选）
            <input type="file" name="file" accept="image/*" />
          </label>
          <div class="btn-row">
            <button type="submit" name="result" value="passed" class="primary" ${isRepairer ? "disabled" : ""}>复检通过</button>
            <button type="submit" name="result" value="failed" class="danger" ${isRepairer ? "disabled" : ""}>复检不通过，退回</button>
          </div>
        </form>
      </section>`;
  }

  function closeBlock(c) {
    if (c.status === "closed") {
      return `
        <section class="d-section done-box closed-box">
          <h3>已关闭归档</h3>
          <p>${esc(c.closeRecord?.note || "（无关闭备注）")} · ${esc(personName(c.closeRecord?.closedBy))} · ${esc(ts(c.closeRecord?.ts))}</p>
        </section>`;
    }
    if (c.status !== "approved") return "";
    const blockers = [];
    if (!c.evidence.length) blockers.push("缺少证据");
    if (!c.damageConfirmed) blockers.push("损坏未确认");
    return `
      <section class="d-section action-box ${blockers.length ? "locked-box" : "ok-box"}">
        <h3>关闭案例</h3>
        ${blockers.length
          ? `<p class="lock-warn">不能关闭：${esc(blockers.join("、"))}。</p>`
          : `<form data-form="close" class="grid-form">
              <label>关闭备注
                <textarea name="note" rows="2" placeholder="归档说明"></textarea>
              </label>
              <button type="submit" class="primary">关闭并归档</button>
            </form>`}
      </section>`;
  }

  function defaultStart() {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return toLocalInput(d);
  }
  function defaultEnd() {
    const d = new Date(defaultStart());
    d.setHours(d.getHours() + 2);
    return toLocalInput(d);
  }
  function toLocalInput(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function materialRowHtml() {
    const opts = store.doc.inventoryItems
      .map((i) => {
        const reserved = H.reservedQty(store.doc, i.id);
        const avail = H.stockOf(store.doc, i.id) - reserved;
        return `<option value="${i.id}">${esc(i.name)}（可用 ${avail}${esc(i.unit)}）</option>`;
      })
      .join("");
    return `
      <div class="material-row">
        <select name="itemId"><option value="">选择库存项…</option>${opts}</select>
        <input type="number" name="qty" min="1" value="1" style="max-width:110px" />
        <button type="button" data-action="remove-material" class="danger">删</button>
      </div>`;
  }

  function hydrateDrawerForms() {
    // 材料行由用户按需添加；无用料时可直接开始修复
  }

  function readMaterials(form) {
    return [...form.querySelectorAll(".material-row")]
      .map((row) => ({ itemId: row.querySelector("[name=itemId]").value, qty: Number(row.querySelector("[name=qty]").value) }))
      .filter((l) => l.itemId && l.qty > 0);
  }

  function readFile(file) {
    return new Promise((resolve) => {
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve({ dataUrl: reader.result });
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  // ---------- 资源 / 库存视图 ----------
  function renderResources() {
    const d = store.doc;
    $("#peopleList").innerHTML = d.people
      .map((p) => {
        const busy = d.cases.filter((c) => c.booking && c.status !== "closed" && c.booking.technicianId === p.id);
        return `
          <div class="resource-row">
            <div><b>${esc(p.name)}</b><span class="muted">${esc(p.role)}</span></div>
            <div class="booking-tags">
              ${busy.map((c) => `<span class="book-tag">${esc(c.code)} ${esc(c.booking.start.replace("T", " "))}–${esc(c.booking.end.slice(11, 16))}</span>`).join("") || `<span class="muted">空闲</span>`}
            </div>
          </div>`;
      })
      .join("");

    $("#devicesList").innerHTML = d.devices
      .map((dev) => {
        const busy = d.cases.filter((c) => c.booking && c.status !== "closed" && c.booking.deviceId === dev.id);
        return `
          <div class="resource-row">
            <div><b>${esc(dev.name)}</b></div>
            <div class="booking-tags">
              ${busy.map((c) => `<span class="book-tag">${esc(c.code)} · ${esc(personName(c.booking.technicianId))}</span>`).join("") || `<span class="muted">空闲</span>`}
            </div>
          </div>`;
      })
      .join("");

    $("#inventoryList").innerHTML = d.inventoryItems
      .map((item) => {
        const stock = H.stockOf(d, item.id);
        const reserved = H.reservedQty(d, item.id);
        const available = stock - reserved;
        return `
          <div class="inventory-row">
            <div>
              <b>${esc(item.name)}</b>
              <span class="muted">${esc(item.sku)} · ${item.type === "segment" ? "替换片段" : "材料"}</span>
            </div>
            <div class="inv-nums">
              <span>库存 <b>${stock}</b>${esc(item.unit)}</span>
              <span class="${reserved ? "warn-text" : ""}">预留 <b>${reserved}</b></span>
              <span>可用 <b class="${available <= 0 ? "danger-text" : ""}">${available}</b></span>
              <button type="button" data-restock="${esc(item.id)}">入库</button>
            </div>
          </div>`;
      })
      .join("");
  }

  // ---------- 旧片段核对台 ----------
  const fallbackThumbs = ["#d49b35", "#347d89", "#b54d48", "#4d7656", "#6d6378"];
  let draggedSegmentId = null;

  function filteredSegments() {
    const color = $("#colorFilter").value;
    const kw = $("#searchInput").value.trim();
    return store.doc.segments.filter((s) => {
      if (color !== "all" && s.shift !== color) return false;
      if (kw && !`${s.code}${s.note}${s.damage}`.includes(kw)) return false;
      return true;
    });
  }

  function renderChecklist() {
    const d = store.doc;
    $("#reelTitle").value = d.reelTitle;
    const segments = filteredSegments();
    $("#segmentList").innerHTML =
      segments
        .map((item) => {
          const realIndex = d.segments.findIndex((s) => s.id === item.id);
          const hasDamage = item.damage !== "完好";
          return `
            <article class="segment-card" draggable="true" data-seg-id="${esc(item.id)}">
              <div class="thumb">
                ${item.thumb
                  ? `<img src="${item.thumb}" alt="${esc(item.code)}缩略图" />`
                  : `<div class="film-placeholder" style="background:${fallbackThumbs[realIndex % fallbackThumbs.length]}">${esc(item.code)}</div>`}
              </div>
              <div class="segment-main">
                <div class="segment-title">
                  <strong>${realIndex + 1}. ${esc(item.code)}</strong>
                  <span>${fmtDuration(item.duration)}</span>
                  <span class="reel-tag">${esc(H.reelById(d, item.reelId)?.name || "")}</span>
                </div>
                <div class="tag-row">
                  <span class="tag">${esc(item.shift)}</span>
                  <span class="tag ${hasDamage ? "damage" : "ok"}">${esc(item.damage)}</span>
                </div>
                <p class="segment-note">${esc(item.note || "没有备注。")}</p>
              </div>
              <div class="segment-actions">
                <button type="button" title="上移" data-move-up="${esc(item.id)}">↑</button>
                <button type="button" title="下移" data-move-down="${esc(item.id)}">↓</button>
                <button type="button" title="删除" data-delete-seg="${esc(item.id)}">×</button>
              </div>
            </article>`;
        })
        .join("") || `<p class="empty">没有符合筛选的片段。</p>`;

    const warnings = d.segments.filter((s) => s.damage !== "完好" || s.shift !== "正常");
    $("#warningList").innerHTML =
      warnings
        .map((item) => {
          const index = d.segments.findIndex((s) => s.id === item.id) + 1;
          const reasons = [item.shift !== "正常" ? item.shift : "", item.damage !== "完好" ? item.damage : ""].filter(Boolean).join(" · ");
          return `
            <div class="warning-item">
              <strong>${index}. ${esc(item.code)}</strong>
              <span>${esc(reasons)}${item.note ? `：${esc(item.note)}` : ""}</span>
            </div>`;
        })
        .join("") || `<p class="empty">当前清单没有颜色偏移或破损提醒。</p>`;
  }

  // ---------- 总渲染 ----------
  function renderAll() {
    $("#undoBtn").disabled = !store.canUndo();
    $("#redoBtn").disabled = !store.canRedo();
    renderStats();
    renderKanban();
    renderResources();
    renderChecklist();
    if (!$("#caseDrawer").classList.contains("hidden")) renderDrawer();
  }
  store.onChange(renderAll);

  // ---------- 登记案例 ----------
  async function submitCase(ev) {
    ev.preventDefault();
    const file = $("#caseEvidenceFile").files[0];
    const fileData = await readFile(file);
    const note = $("#caseEvidenceNote").value.trim();
    const evidence = [];
    if (fileData) evidence.push({ kind: "photo", name: file.name || "影像证据", note, dataUrl: fileData.dataUrl });
    else if (note) evidence.push({ kind: "note", name: "初检记录", note });

    const segIds = $$('#caseSegments input[type="checkbox"]:checked').map((i) => i.value);
    const segmentCodes = store.doc.segments.filter((s) => segIds.includes(s.id)).map((s) => s.code);

    const out = runTx("登记案例", (d, ctx) =>
      FR.Ops.registerCase(d, ctx, {
        code: $("#caseCode").value.trim(),
        title: $("#caseTitle").value,
        reelId: $("#caseReel").value,
        incidentType: $("#caseType").value,
        severity: $("#caseSeverity").value,
        description: $("#caseDesc").value,
        responsiblePersonId: $("#caseResponsible").value,
        segmentCodes,
        evidence,
        damageConfirmed: $("#caseDamageConfirmed").checked,
        actorId: actorId()
      }), "案例已登记");
    if (out) {
      ev.target.reset();
      saveUiState({ caseDraft: {}, caseSegments: [] });
      renderSegmentCheckboxes();
      const created = out.doc.cases.at(-1);
      openDrawer(created.id);
    }
  }

  // ---------- 抽屉里的动作 ----------
  async function handleDrawerSubmit(ev) {
    const form = ev.target.closest("[data-form]");
    if (!form || !$("#caseDrawer").contains(form)) return;
    ev.preventDefault();
    const c = H.caseById(store.doc, uiState.openCaseId);
    if (!c) return;
    const kind = form.dataset.form;
    const fd = new FormData(form);

    if (kind === "evidence") {
      const file = form.querySelector("[type=file]").files[0];
      const fileData = await readFile(file);
      const partial = {
        kind: fileData ? "photo" : "note",
        name: fd.get("name")?.trim() || (fileData ? file.name || "影像证据" : "文字记录"),
        note: fd.get("note") || "",
        dataUrl: fileData?.dataUrl || ""
      };
      runTx("补充证据", (d, ctx) => FR.Ops.addEvidence(d, ctx, c.id, partial, actorId()), "证据已补充");
    }

    if (kind === "dispatch") {
      runTx("派工", (d, ctx) =>
        FR.Ops.dispatch(d, ctx, c.id, {
          technicianId: fd.get("technicianId"),
          deviceId: fd.get("deviceId"),
          start: fd.get("start"),
          end: fd.get("end")
        }, actorId()), "派工成功");
    }

    if (kind === "start-repair") {
      const materials = readMaterials(form);
      runTx("开始修复", (d, ctx) => FR.Ops.startRepair(d, ctx, c.id, { materials }, actorId()), "资源校验通过，库存已预留，开始修复");
    }

    if (kind === "complete-repair") {
      const result = ev.submitter?.value || "success";
      runTx("提交修复", (d, ctx) =>
        FR.Ops.completeRepair(d, ctx, c.id, {
          result,
          note: fd.get("note"),
          replacementSegmentCode: fd.get("replacementSegmentCode") || ""
        }, actorId()), result === "success" ? "修复完成，进入复检" : "");
    }

    if (kind === "review") {
      const result = ev.submitter?.value || "passed";
      const file = form.querySelector("[type=file]")?.files[0];
      const fileData = await readFile(file);
      runTx("复检", (d, ctx) =>
        FR.Ops.review(d, ctx, c.id, {
          result,
          note: fd.get("note"),
          evidence: fileData ? { kind: "photo", name: file.name || "复检影像", note: fd.get("note") || "", dataUrl: fileData.dataUrl } : null
        }, actorId()), result === "passed" ? "复检通过" : "复检不通过，已退回派工");
    }

    if (kind === "close") {
      runTx("关闭案例", (d, ctx) => FR.Ops.closeCase(d, ctx, c.id, fd.get("note"), actorId()), "案例已关闭归档");
    }
  }

  function handleDrawerClick(ev) {
    const actionEl = ev.target.closest("[data-action]");
    const c = H.caseById(store.doc, uiState.openCaseId);
    if (!actionEl || !c) return;
    const action = actionEl.dataset.action;
    if (action === "add-material") {
      $("[data-material-lines]").insertAdjacentHTML("beforeend", materialRowHtml());
    }
    if (action === "remove-material") {
      actionEl.closest(".material-row").remove();
    }
    if (action === "confirm-damage") {
      runTx("确认损坏", (d, ctx) => FR.Ops.confirmDamage(d, ctx, c.id, actorId()), "损坏已确认");
    }
  }

  // ---------- 片段表单 / 排序 ----------
  async function submitSegment(ev) {
    ev.preventDefault();
    const thumb = (await readFile($("#thumbInput").files[0]))?.dataUrl || "";
    runTx("录入片段", (d, ctx) => {
      d.segments.push({
        id: ctx.uid("s"),
        reelId: $("#segmentReel").value,
        code: $("#codeInput").value.trim(),
        duration: Number($("#durationInput").value),
        shift: $("#shiftInput").value,
        damage: $("#damageInput").value,
        note: $("#noteInput").value.trim(),
        thumb
      });
    }, "片段已加入清单");
    ev.target.reset();
    $("#durationInput").value = 12;
  }

  function moveSegment(id, dir) {
    runTx("调整顺序", (d) => {
      const i = d.segments.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.segments.length) return;
      const [x] = d.segments.splice(i, 1);
      d.segments.splice(j, 0, x);
    });
  }

  // ---------- 导出 ----------
  function download(obj, filename, type = "application/json;charset=utf-8") {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function exportSnapshot() {
    const snap = store.exportSnapshot();
    download(snap, `film-rescue-snapshot-${Date.now()}.json`);
    toast("已导出离线快照，可在另一个标签页用「合并页面」导入。", "ok", 5000);
  }

  function exportIncidentPackage() {
    const drawerOpen = !$("#caseDrawer").classList.contains("hidden");
    const id = drawerOpen ? uiState.openCaseId : uiState.lastCaseId;
    if (!id) {
      toast("请先打开一个事故案例，再导出它的事故包。", "warn");
      return;
    }
    try {
      const pkg = store.exportIncidentPackage(id);
      download(pkg, `${pkg.incident.code}-incident-package.json`);
      toast(`事故包 ${pkg.incident.code} 已导出。`, "ok");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  function exportChecklist() {
    const d = store.doc;
    const lines = [
      `胶片卷：${d.reelTitle || "未命名胶片卷"}`,
      `总时长：${fmtDuration(d.segments.reduce((s, x) => s + Number(x.duration), 0))}`,
      "",
      ...d.segments.map((s, i) => `${i + 1}. ${s.code}｜${fmtDuration(s.duration)}｜${s.shift}｜${s.damage}｜${s.note || "无备注"}`)
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${d.reelTitle || "film-reel"}-checklist.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // ---------- 离线合并中心 ----------
  async function importSnapshotFile(file) {
    try {
      const text = await file.text();
      const snap = JSON.parse(text);
      if (snap.kind === "film-rescue-offline-snapshot" && snap.doc) {
        ingestIncoming(snap.doc, "离线快照");
      } else if (snap.v === 2 && snap.doc) {
        ingestIncoming(snap.doc, "标签页快照");
      } else {
        toast("文件不是有效的离线快照。", "error");
      }
    } catch (e) {
      toast("快照解析失败：" + (e.message || e), "error");
    }
  }

  function ingestIncoming(doc, sourceName) {
    const result = store.ingest(doc);
    if (result.status === "identical") toast(`${sourceName} 与本页完全一致，无需合并。`, "ok");
    else if (result.status === "behind") toast(`${sourceName} 是更旧的版本，已忽略。`, "warn");
    else if (result.status === "fastforward" || result.status === "merged") {
      toast(`${sourceName}已无冲突合并进本页。`, "ok", 5000);
    } else if (result.status === "blocked") {
      // 无字段冲突、但合并结果违反技师/设备/库存约束：整批阻止，不写入
      mergePlan = { incomingDoc: doc, conflicts: [], violations: result.violations, logs: [], sourceName };
      openMergeModal();
    } else if (result.status === "conflict") {
      mergePlan = { incomingDoc: doc, conflicts: result.conflicts, violations: result.violations || [], logs: result.logs, sourceName };
      openMergeModal();
    }
  }

  function conflictRowHtml(cf, idx) {
    if (cf.kind === "duplicate") {
      return `
        <div class="conflict-row" data-key="${esc(cf.key)}">
          <div class="conflict-head"><b>【${esc(cf.entity)}】${esc(cf.label)}</b><span>跨页重复登记，需二选一</span></div>
          <div class="conflict-options">
            <label><input type="radio" name="cf-${idx}" value="local" checked /><span class="opt-local">${esc(cf.local)}</span></label>
            <label><input type="radio" name="cf-${idx}" value="incoming" /><span class="opt-incoming">${esc(cf.incoming)}</span></label>
          </div>
        </div>`;
    }
    return `
      <div class="conflict-row" data-key="${esc(cf.key)}">
        <div class="conflict-head">
          <b>【${esc(cf.entity)}】${esc(cf.entityName)} · ${esc(cf.label)}</b>
          <span class="conflict-base">共同基端：${esc(cf.base)}</span>
        </div>
        <div class="conflict-options">
          <label><input type="radio" name="cf-${idx}" value="local" checked />
            <span><em>本页</em>${esc(cf.local)}</span></label>
          <label><input type="radio" name="cf-${idx}" value="incoming" />
            <span><em>离线页</em>${esc(cf.incoming)}</span></label>
        </div>
      </div>`;
  }

  function violationRowHtml(v) {
    const icon =
      v.kind === "stock-overrun" ? "📦" : v.kind === "technician-overlap" ? "👤" : "🎛️";
    return `<li class="violation-item">${icon} ${esc(v.message)}</li>`;
  }

  function openMergeModal() {
    const { conflicts, violations, logs, sourceName } = mergePlan;
    $("#mergeBody").innerHTML = `
      <p class="muted">检测到 ${conflicts.length} 项同一案例/记录的并发修改，请逐项裁决；完全重复的登记与证据已自动只吸收一次。</p>
      ${logs.length ? `<ul class="merge-logs">${logs.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
      <div class="conflict-list">${conflicts.map((cf, i) => conflictRowHtml(cf, i)).join("")}</div>
      <div class="violation-block ${violations.length ? "has-violations" : ""}" id="mergeViolations">
        ${violations.length ? renderViolations(violations) : ""}
      </div>`;
    $("#mergeMask").classList.remove("hidden");
    updateMergeCommitState(violations.length > 0);
  }

  function renderViolations(list) {
    return `
      <h3 class="violation-title">合并被资源/库存约束阻止（${list.length}）</h3>
      <p class="muted">以下冲突由两个页面各自合法、合在一起造成；请在任一页面调整派工/预留后重新合并，当前不会写入任何数据。</p>
      <ul class="violation-list">${list.map(violationRowHtml).join("")}</ul>`;
  }

  function updateMergeCommitState(blocked) {
    const btn = $("#mergeCommit");
    btn.disabled = blocked;
    btn.textContent = blocked ? "存在资源/库存冲突，无法合并" : "按裁决合并";
    btn.classList.toggle("primary", !blocked);
  }

  // 裁决改变后，不写入地重新预览合并结果的资源/库存违规
  function refreshMergeViolations() {
    if (!mergePlan) return;
    const decisions = collectMergeDecisions();
    let violations = [];
    try {
      violations = store.previewMergeViolations(mergePlan.incomingDoc, decisions);
    } catch {
      violations = mergePlan.violations || [];
    }
    mergePlan.violations = violations;
    const box = $("#mergeViolations");
    box.classList.toggle("has-violations", violations.length > 0);
    box.innerHTML = violations.length ? renderViolations(violations) : "";
    updateMergeCommitState(violations.length > 0);
  }

  function collectMergeDecisions() {
    const decisions = {};
    $$(".conflict-row", $("#mergeBody")).forEach((row, idx) => {
      const checked = $(`input[name=cf-${idx}]:checked`, $("#mergeBody"));
      decisions[row.dataset.key] = checked?.value || "local";
    });
    return decisions;
  }

  function commitMerge() {
    const decisions = collectMergeDecisions();
    try {
      store.resolveConflict(mergePlan.incomingDoc, decisions);
      toast("合并完成，冲突已按逐项裁决落盘。", "ok", 5000);
      $("#mergeMask").classList.add("hidden");
      mergePlan = null;
    } catch (e) {
      // 核心层兜底：若仍有资源/库存违规，留在弹窗内并列出，阻止写入
      if (e.violations) {
        mergePlan.violations = e.violations;
        const box = $("#mergeViolations");
        box.classList.add("has-violations");
        box.innerHTML = renderViolations(e.violations);
        updateMergeCommitState(true);
      }
      toast(e.message, "error", 7000);
    }
  }

  // ---------- 跨标签页实时合并 ----------
  let autoMerge = true;
  window.addEventListener("storage", (ev) => {
    if (!autoMerge) return; // 测试钩子：模拟真正离线、收不到对端更新的标签页
    if (ev.key !== FR.KEYS.APP_KEY || !ev.newValue) return;
    try {
      const remote = JSON.parse(ev.newValue);
      if (remote.doc && remote.clientId !== store.clientId) {
        ingestIncoming(remote.doc, "另一标签页的修改");
      }
    } catch {
      /* 远端写入不完整时忽略 */
    }
  });

  // ---------- 标签页切换 ----------
  function switchTab(name) {
    saveUiState({ activeTab: name });
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    $("#view-board").classList.toggle("hidden", name !== "board");
    $("#view-check").classList.toggle("hidden", name !== "check");
    $("#view-resources").classList.toggle("hidden", name !== "resources");
  }

  // ---------- 事件绑定 ----------
  function bind() {
    $("#actorSelect").addEventListener("change", () => {
      saveUiState({ actorId: actorId() });
      renderDrawer();
    });
    $$(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

    $("#caseForm").addEventListener("submit", submitCase);
    $("#caseSegments").addEventListener("change", (ev) => {
      const chosen = $$('#caseSegments input[type="checkbox"]:checked').map((i) => i.value);
      saveUiState({ caseSegments: chosen });
    });
    ["caseCode", "caseTitle", "caseDesc", "caseEvidenceNote"].forEach((id) =>
      $(`#${id}`).addEventListener("input", persistCaseDraft)
    );
    ["caseSeverity", "caseType", "caseReel", "caseResponsible", "caseDamageConfirmed"].forEach((id) =>
      $(`#${id}`).addEventListener("change", persistCaseDraft)
    );
    function persistCaseDraft() {
      saveUiState({
        caseDraft: {
          caseCode: $("#caseCode").value,
          caseTitle: $("#caseTitle").value,
          caseDesc: $("#caseDesc").value,
          caseEvidenceNote: $("#caseEvidenceNote").value,
          caseSeverity: $("#caseSeverity").value,
          caseType: $("#caseType").value,
          caseReel: $("#caseReel").value,
          caseResponsible: $("#caseResponsible").value,
          caseDamageConfirmed: $("#caseDamageConfirmed").checked
        }
      });
    }

    $("#boardSearch").addEventListener("input", () => { renderKanban(); saveBoardFilters(); });
    $("#boardSeverityFilter").addEventListener("change", () => { renderKanban(); saveBoardFilters(); });
    $("#boardReelFilter").addEventListener("change", () => { renderKanban(); saveBoardFilters(); });
    function saveBoardFilters() {
      saveUiState({
        boardSearch: $("#boardSearch").value,
        boardSeverity: $("#boardSeverityFilter").value,
        boardReel: $("#boardReelFilter").value
      });
    }

    $("#kanban").addEventListener("click", (ev) => {
      const card = ev.target.closest("[data-case]");
      if (card) openDrawer(card.dataset.case);
    });
    $("#kanban").addEventListener("keydown", (ev) => {
      const card = ev.target.closest("[data-case]");
      if (card && (ev.key === "Enter" || ev.key === " ")) openDrawer(card.dataset.case);
    });
    $("#drawerClose").addEventListener("click", closeDrawer);
    $("#drawerMask").addEventListener("click", closeDrawer);
    $("#caseDrawer").addEventListener("submit", handleDrawerSubmit);
    $("#caseDrawer").addEventListener("click", handleDrawerClick);

    $("#segmentForm").addEventListener("submit", submitSegment);
    $("#segmentList").addEventListener("click", (ev) => {
      const up = ev.target.closest("[data-move-up]");
      const down = ev.target.closest("[data-move-down]");
      const del = ev.target.closest("[data-delete-seg]");
      if (up) moveSegment(up.dataset.moveUp, -1);
      if (down) moveSegment(down.dataset.moveDown, 1);
      if (del) runTx("删除片段", (d) => { d.segments = d.segments.filter((s) => s.id !== del.dataset.deleteSeg); }, "片段已删除");
    });
    $("#segmentList").addEventListener("dragstart", (ev) => {
      const card = ev.target.closest("[data-seg-id]");
      if (!card) return;
      draggedSegmentId = card.dataset.segId;
      card.classList.add("dragging");
      ev.dataTransfer.effectAllowed = "move";
    });
    $("#segmentList").addEventListener("dragend", (ev) => {
      ev.target.closest("[data-seg-id]")?.classList.remove("dragging");
      draggedSegmentId = null;
    });
    $("#segmentList").addEventListener("dragover", (ev) => {
      const card = ev.target.closest("[data-seg-id]");
      if (!card || !draggedSegmentId || card.dataset.segId === draggedSegmentId) return;
      ev.preventDefault();
      const d = store.doc;
      const from = d.segments.findIndex((s) => s.id === draggedSegmentId);
      const to = d.segments.findIndex((s) => s.id === card.dataset.segId);
      if (from < 0 || to < 0) return;
      runTx("拖拽排序", (draft) => {
        const [x] = draft.segments.splice(from, 1);
        draft.segments.splice(to, 0, x);
      });
    });

    $("#colorFilter").addEventListener("change", () => { renderChecklist(); saveUiState({ colorFilter: $("#colorFilter").value }); });
    $("#searchInput").addEventListener("input", () => { renderChecklist(); saveUiState({ searchInput: $("#searchInput").value }); });
    $("#reelTitle").addEventListener("input", () => {
      const v = $("#reelTitle").value;
      runTxSilent((d) => { d.reelTitle = v; });
    });

    $("#inventoryList").addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-restock]");
      if (!btn) return;
      const n = Number(prompt("入库数量：", "5"));
      if (Number.isFinite(n) && n > 0) {
        runTx("入库", (d, ctx) => FR.Ops.restock(d, ctx, btn.dataset.restock, n, actorId()), `已入库 ${n}`);
      }
    });

    $("#undoBtn").addEventListener("click", safeUndoRedo(() => store.undo()));
    $("#redoBtn").addEventListener("click", safeUndoRedo(() => store.redo()));
    window.addEventListener("keydown", (ev) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName);
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z" && !ev.shiftKey) {
        if (!typing) { ev.preventDefault(); safeUndoRedo(() => store.undo())(); }
      }
      if ((ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === "y" || (ev.key.toLowerCase() === "z" && ev.shiftKey))) {
        if (!typing) { ev.preventDefault(); safeUndoRedo(() => store.redo())(); }
      }
      if (ev.key === "Escape") {
        if (!$("#mergeMask").classList.contains("hidden")) $("#mergeMask").classList.add("hidden");
        else closeDrawer();
      }
    });
    function safeUndoRedo(fn) {
      return () => {
        try {
          fn();
        } catch (e) {
          toast(e.message, "error", 7000);
        }
      };
    }

    // reelTitle 输入不弹成功 toast
    function runTxSilent(fn) {
      try {
        store.apply(fn, "更新");
      } catch (e) {
        toast(e.message, "error", 7000);
      }
    }

    $("#exportSnapshotBtn").addEventListener("click", exportSnapshot);
    $("#importSnapshotBtn").addEventListener("click", () => $("#importSnapshotFile").click());
    $("#importSnapshotFile").addEventListener("change", (ev) => {
      const f = ev.target.files[0];
      if (f) importSnapshotFile(f);
      ev.target.value = "";
    });
    $("#exportPackageBtn").addEventListener("click", exportIncidentPackage);
    $("#exportBtn").addEventListener("click", exportChecklist);
    $("#failNextBtn").addEventListener("click", () => {
      store.adapter.setFailNext(true);
      toast("故障注入已开启：下一次保存将失败并整单回滚。", "warn", 5000);
    });

    $("#mergeCancel").addEventListener("click", () => { $("#mergeMask").classList.add("hidden"); mergePlan = null; });
    $("#mergeCommit").addEventListener("click", commitMerge);
    $("#mergeTakeIncomingAll").addEventListener("change", (ev) => {
      $$("#mergeBody .conflict-row").forEach((row, idx) => {
        const val = ev.target.checked ? "incoming" : "local";
        const radio = $(`input[name=cf-${idx}][value=${val}]`, $("#mergeBody"));
        if (radio) radio.checked = true;
      });
      refreshMergeViolations();
    });
    // 任一字段裁决改变后，实时重算资源/库存违规并更新提交按钮
    $("#mergeBody").addEventListener("change", (ev) => {
      if (ev.target.matches("input[type=radio]")) refreshMergeViolations();
    });
  }

  // ---------- 恢复现场 ----------
  function restoreScene() {
    if (uiState.activeTab) switchTab(uiState.activeTab);
    const draft = uiState.caseDraft || {};
    for (const [id, val] of Object.entries(draft)) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === "checkbox") el.checked = !!val;
      else el.value = val ?? "";
    }
    if (uiState.boardSearch !== undefined) $("#boardSearch").value = uiState.boardSearch;
    if (uiState.boardSeverity) $("#boardSeverityFilter").value = uiState.boardSeverity;
    if (uiState.boardReel) $("#boardReelFilter").value = uiState.boardReel;
    if (uiState.colorFilter) $("#colorFilter").value = uiState.colorFilter;
    if (uiState.searchInput !== undefined) $("#searchInput").value = uiState.searchInput;
  }

  // ---------- 启动 ----------
  renderActorSelect();
  renderStaticOptions();
  bind();
  restoreScene();
  renderAll();
  if (uiState.openCaseId && H.caseById(store.doc, uiState.openCaseId)) {
    $("#drawerMask").classList.remove("hidden");
    $("#caseDrawer").classList.remove("hidden");
    renderDrawer();
  }

  // 供浏览器测试使用
  window.__RESCUE__ = {
    store,
    FR,
    setAutoMerge(v) {
      autoMerge = !!v;
    }
  };
})();
