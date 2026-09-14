"use strict";
/* 航空维修检查协作台 前端 SPA（原生 JS，无构建）
 * 能力：登录/看板/模板编辑发布/检查单录入/缺陷闭环/双人签署/撤销/导入导出
 *      离线编辑（localStorage 草稿 + 操作队列，联网自动同步，刷新不丢）
 *      多标签冲突提示（BroadcastChannel + 服务端 409 乐观锁）
 */
(function () {
  /* ---------------- 状态与存储 ---------------- */
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
    del(k) { localStorage.removeItem(k); },
  };
  const state = {
    token: LS.get("token", null),
    user: LS.get("user", null),
    view: "dash",
    templates: [],
    instances: [],
    instance: null,       // 当前打开的检查单（含 items 计算）
    template: null,       // 当前打开的模板
    tplDraft: null,       // 模板草稿编辑中的 items
    openItems: {},        // 检查项展开状态
    online: navigator.onLine,
    syncing: false,
  };
  let pendingOps = LS.get("pendingOps", []);
  const bc = "BroadcastChannel" in window ? new BroadcastChannel("hxwl-ins") : null;

  /* ---------------- 工具 ---------------- */
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "-");

  function toast(msg, kind) {
    const el = document.createElement("div");
    el.className = "toast " + (kind || "");
    el.textContent = msg;
    $("#toast-root").appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  function modal(html) {
    const root = $("#modal-root");
    root.innerHTML = `<div class="mask" onclick="if(event.target===this)App.closeModal()"><div class="modal">${html}</div></div>`;
  }
  function closeModal() { $("#modal-root").innerHTML = ""; }

  function setConflict(msg) {
    const bar = $("#conflict-banner");
    if (!msg) { bar.classList.add("hidden"); return; }
    bar.innerHTML = `<span>⚠ ${esc(msg)}</span><button class="btn small danger" onclick="App.reloadCurrent()">刷新数据</button><button class="btn small" onclick="App.setConflict('')">知道了</button>`;
    bar.classList.remove("hidden");
  }

  function renderNetStatus() {
    const el = $("#net-status");
    if (!state.online) { el.textContent = "● 离线中（可继续编辑）"; el.className = "net-status offline"; }
    else if (pendingOps.length) { el.textContent = `● 待同步 ${pendingOps.length} 条`; el.className = "net-status pending"; }
    else { el.textContent = "● 在线"; el.className = "net-status"; }
  }

  /* ---------------- API 封装（含离线队列） ---------------- */
  class OfflineError extends Error {}

  async function api(path, opts = {}) {
    if (!state.online) throw new OfflineError("当前离线");
    let res;
    try {
      res = await fetch(path, {
        method: opts.method || "GET",
        headers: Object.assign(
          { "Content-Type": "application/json", Authorization: state.token ? "Bearer " + state.token : "" },
          opts.headers || {}
        ),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      throw new OfflineError("网络不可用");
    }
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `请求失败(${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /** 结果保存：离线时入本地队列并乐观更新，联网后自动同步 */
  async function saveResult(insId, itemCode, payload) {
    if (!state.online) {
      pendingOps = pendingOps.filter((o) => !(o.insId === insId && o.itemCode === itemCode));
      pendingOps.push({ insId, itemCode, ...payload, at: Date.now() });
      LS.set("pendingOps", pendingOps);
      if (state.instance && state.instance.id === insId) {
        state.instance.results[itemCode] = { ...payload, updatedBy: state.user.displayName + "(离线)", updatedAt: new Date().toISOString() };
      }
      renderNetStatus();
      toast("已离线保存，联网后自动同步", "ok");
      return null;
    }
    const data = await api(`/api/instances/${insId}/results/${encodeURIComponent(itemCode)}`, {
      method: "PUT",
      body: { ...payload, baseRevision: state.instance ? state.instance.revision : undefined },
    });
    return data.instance;
  }

  async function syncPending() {
    if (!state.online || state.syncing || !pendingOps.length || !state.token) return;
    state.syncing = true;
    const ops = pendingOps.slice();
    for (const op of ops) {
      try {
        const fresh = await api(`/api/instances/${op.insId}`);
        await api(`/api/instances/${op.insId}/results/${encodeURIComponent(op.itemCode)}`, {
          method: "PUT",
          body: { status: op.status, value: op.value, notes: op.notes, baseRevision: fresh.instance.revision },
        });
        pendingOps = pendingOps.filter((o) => o !== op);
        LS.set("pendingOps", pendingOps);
      } catch (e) {
        if (e.status === 409) {
          setConflict(`检查项 ${op.itemCode} 同步时与他人修改冲突，已保留对方数据，请刷新确认`);
          pendingOps = pendingOps.filter((o) => o !== op);
          LS.set("pendingOps", pendingOps);
        } else if (e.status === 423) {
          toast("检查单已签署，离线修改无法同步", "error");
          pendingOps = pendingOps.filter((o) => o !== op);
          LS.set("pendingOps", pendingOps);
        } else if (!(e instanceof OfflineError)) {
          toast(`同步失败：${e.message}`, "error");
          pendingOps = pendingOps.filter((o) => o !== op);
          LS.set("pendingOps", pendingOps);
        }
      }
    }
    state.syncing = false;
    renderNetStatus();
    if (state.view === "instance" && state.instance) openInstance(state.instance.id, true);
    if (state.view === "dash") loadDash();
  }

  /* ---------------- 多标签协调 ---------------- */
  function broadcastChanged(insId, revision) {
    if (bc) bc.postMessage({ type: "instance-changed", insId, revision, tab: tabId });
  }
  const tabId = Math.random().toString(36).slice(2);
  if (bc) {
    bc.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.tab === tabId) return;
      if (m.type === "instance-changed" && state.view === "instance" && state.instance && state.instance.id === m.insId) {
        const dirty = pendingOps.some((o) => o.insId === m.insId) || hasDrafts(m.insId);
        if (dirty) setConflict("另一个标签页已修改此检查单，而本页有未同步的编辑");
        else openInstance(m.insId, true);
      }
    };
  }
  function hasDrafts(insId) {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(`draft:${insId}:`)) return true;
    }
    return false;
  }

  function handleApiError(e, contextInsId) {
    if (e.status === 409) {
      setConflict(e.message || "数据已被他人修改，请刷新");
      if (contextInsId) openInstance(contextInsId, true);
    } else if (e.status === 401) {
      logout();
      toast("登录已失效，请重新登录", "error");
    } else if (e instanceof OfflineError) {
      toast("当前离线，该操作需要联网", "error");
    } else {
      toast(e.message || "操作失败", "error");
    }
  }

  /* ---------------- 登录 ---------------- */
  function renderLogin() {
    $("#user-chip").innerHTML = "";
    $("#app").innerHTML = `
      <div class="card" style="max-width:420px;margin:40px auto;">
        <h2>登录</h2>
        <label class="field"><span>用户名</span><input id="lg-user" type="text" autocomplete="username" placeholder="如 wang"></label>
        <label class="field"><span>密码</span><input id="lg-pass" type="password" autocomplete="current-password" placeholder="如 wang123"></label>
        <button class="btn primary" style="width:100%" onclick="App.doLogin()">登 录</button>
        <p class="meta" style="color:var(--muted);font-size:12px;margin-top:12px">
          演示账号：admin/admin123（管理）· wang、li（工程师，密码 用户名+123）· zhao、chen（检验，密码 用户名+123）
        </p>
      </div>`;
  }

  async function doLogin() {
    try {
      const data = await api("/api/auth/login", {
        method: "POST",
        body: { username: $("#lg-user").value.trim(), password: $("#lg-pass").value },
      });
      state.token = data.token; state.user = data.user;
      LS.set("token", data.token); LS.set("user", data.user);
      location.hash = "#/dash";
      boot();
    } catch (e) { toast(e.message, "error"); }
  }

  async function logout() {
    try { await api("/api/auth/logout", { method: "POST" }); } catch {}
    state.token = null; state.user = null;
    LS.del("token"); LS.del("user");
    location.hash = "#/login";
    boot();
  }

  /* ---------------- 看板 ---------------- */
  async function loadDash() {
    try {
      const [ins, tpl] = await Promise.all([api("/api/instances"), api("/api/templates")]);
      state.instances = ins.instances;
      state.templates = tpl.templates;
      renderDash();
    } catch (e) {
      if (e instanceof OfflineError) renderDashOffline();
      else handleApiError(e);
    }
  }

  function renderDashOffline() {
    $("#app").innerHTML = `<div class="card"><h2>离线模式</h2><p>当前无网络连接。已缓存的检查单可继续查看编辑（打开过的检查单会保留在本地）。</p>
      ${pendingOps.length ? `<p>有 ${pendingOps.length} 条修改待同步。</p>` : ""}</div>`;
  }

  function dashTab() { return state.dashTab || "instances"; }

  function renderDash() {
    const tab = dashTab();
    const isAdmin = state.user.roles.includes("admin");
    $("#app").innerHTML = `
      <div class="tabs">
        <button class="${tab === "instances" ? "active" : ""}" onclick="App.switchTab('instances')">检查单</button>
        <button class="${tab === "templates" ? "active" : ""}" onclick="App.switchTab('templates')">检查模板</button>
      </div>
      ${tab === "instances" ? instancesHtml() : templatesHtml(isAdmin)}`;
  }

  function instancesHtml() {
    const rows = state.instances.map((i) => {
      const pct = i.progress.applicable ? Math.round((i.progress.completed / i.progress.applicable) * 100) : 0;
      return `<div class="list-row" onclick="App.openInstance('${i.id}')">
        <div class="grow">
          <div class="title">${esc(i.title)} <span class="badge ${i.status}">${i.status === "signed" ? "已签署" : "进行中"}</span></div>
          <div class="meta">${esc(i.templateName)} v${i.versionNo} · ${esc(i.aircraft || "未填机号")} · ${i.createdBy} · ${fmtTime(i.createdAt)}</div>
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
          <div class="meta">完成 ${i.progress.completed}/${i.progress.applicable} · 未闭环缺陷 ${i.progress.openDefects} · 签署 ${i.signatures.length}/2</div>
        </div><span>›</span></div>`;
    }).join("");
    return `<div class="view-title"><h1>检查单</h1>
        <button class="btn primary" onclick="App.newInstanceModal()">＋ 新建检查单</button>
        <button class="btn" onclick="App.exportAllHint()">导出</button>
        <label class="btn" style="margin:0">导入整包<input type="file" accept=".json,.aipkg" style="display:none" onchange="App.importPackage(this)"></label>
      </div>
      ${state.instances.length ? rows : '<div class="empty">暂无检查单，点击"新建检查单"开始</div>'}`;
  }

  function templatesHtml(isAdmin) {
    const rows = state.templates.map((t) => {
      const vers = t.versions.map((v) => `<span class="badge ${v.status}" title="${esc(v.hash.slice(0, 12))}">v${v.versionNo} ${v.status === "published" ? "已发布" : "草稿"}</span>`).join(" ");
      return `<div class="list-row" onclick="App.openTemplate('${t.id}')">
        <div class="grow"><div class="title">${esc(t.name)}</div>
        <div class="meta">${esc(t.ataChapter || "")} ${esc(t.description || "")}</div>
        <div style="margin-top:4px">${vers}</div></div><span>›</span></div>`;
    }).join("");
    return `<div class="view-title"><h1>检查模板</h1>
      ${isAdmin ? '<button class="btn primary" onclick="App.newTemplateModal()">＋ 新建模板</button>' : '<span class="meta">模板管理需管理员角色</span>'}
      </div>${rows || '<div class="empty">暂无模板</div>'}`;
  }

  /* ---------------- 模板编辑 ---------------- */
  async function openTemplate(tplId) {
    try {
      const data = await api(`/api/templates/${tplId}`);
      state.template = data.template;
      const draft = data.template.versions.find((v) => v.status === "draft");
      state.tplDraft = draft ? JSON.parse(JSON.stringify(draft.items)) : null;
      state.tplDraftVersionId = draft ? draft.id : null;
      state.view = "template";
      renderTemplate();
    } catch (e) { handleApiError(e); }
  }

  function renderTemplate(errors) {
    const t = state.template;
    const isAdmin = state.user.roles.includes("admin");
    const versions = t.versions.map((v) => `
      <div class="list-row" style="cursor:default">
        <div class="grow"><span class="badge ${v.status}">v${v.versionNo} ${v.status === "published" ? "已发布·冻结" : "草稿"}</span>
        <span class="meta"> ${v.itemCount} 项 · ${v.publishedAt ? "发布于 " + fmtTime(v.publishedAt) + " · " + esc(v.publishedBy || "") : "未发布"}</span>
        <div class="mono">hash: ${esc(v.hash.slice(0, 16))}…</div></div>
        ${v.status === "published" ? `<button class="btn small primary" onclick="App.newInstanceFromVersion('${v.id}')">新建检查单</button>` : ""}
      </div>`).join("");

    const draftEditor = state.tplDraft ? `
      <div class="card"><h2>草稿编辑（v${t.versions.find((v) => v.status === "draft").versionNo}）</h2>
        ${errors && errors.length ? `<div class="error-list">${errors.map((e) => `<div>· ${esc(e)}</div>`).join("")}</div>` : ""}
        ${state.tplDraft.map((it, idx) => tplItemHtml(it, idx)).join("")}
        <div class="btn-row">
          <button class="btn" onclick="App.tplAddItem()">＋ 添加检查项</button>
          <button class="btn primary" onclick="App.tplSave()">保存草稿</button>
          <button class="btn accent" onclick="App.tplPublish()">发布此版本（发布后冻结）</button>
        </div>
      </div>` : (isAdmin ? `<div class="card"><button class="btn primary" onclick="App.tplNewVersion()">基于最新版本创建新草稿</button></div>` : "");

    $("#app").innerHTML = `
      <div class="view-title"><button class="btn ghost" onclick="App.back()">‹ 返回</button><h1>${esc(t.name)}</h1></div>
      <div class="card"><h2>版本列表</h2>${versions}</div>
      ${draftEditor}`;
  }

  function tplItemHtml(it, idx) {
    const condCodeOptions = state.tplDraft.filter((x) => x.code && x.code !== it.code)
      .map((x) => `<option value="${esc(x.code)}" ${it.visibleWhen && it.visibleWhen.code === x.code ? "selected" : ""}>${esc(x.code)}</option>`).join("");
    return `<div class="tpl-item">
      <div class="row">
        <input type="text" placeholder="编码*" value="${esc(it.code)}" onchange="App.tplSet(${idx},'code',this.value)">
        <input type="text" placeholder="标题*" value="${esc(it.title)}" onchange="App.tplSet(${idx},'title',this.value)">
        <input type="text" placeholder="分类" value="${esc(it.category || "")}" onchange="App.tplSet(${idx},'category',this.value)">
      </div>
      <div class="row2">
        <input type="text" placeholder="前置依赖编码，逗号分隔（如 EXT-01,ENG-01）" value="${esc((it.deps || []).join(","))}" onchange="App.tplSetDeps(${idx},this.value)">
        <div style="display:flex;gap:6px;align-items:center">
          <select onchange="App.tplSetCond(${idx},this.value)" style="flex:1">
            <option value="">无条件（始终适用）</option>${condCodeOptions}
          </select>
          ${it.visibleWhen ? `<select onchange="App.tplSetCondVal(${idx},this.value)"><option value="fail" ${it.visibleWhen.in[0] === "fail" ? "selected" : ""}>当结果为 不通过</option><option value="pass" ${it.visibleWhen.in[0] === "pass" ? "selected" : ""}>当结果为 通过</option><option value="na" ${it.visibleWhen.in[0] === "na" ? "selected" : ""}>当结果为 不适用</option></select>` : ""}
          <button class="btn small danger" onclick="App.tplRemoveItem(${idx})">删除</button>
        </div>
      </div>
      <input type="text" placeholder="检查说明" value="${esc(it.description || "")}" onchange="App.tplSet(${idx},'description',this.value)">
    </div>`;
  }

  async function tplSave() {
    try {
      await api(`/api/templates/${state.template.id}/versions/${state.tplDraftVersionId}`, {
        method: "PUT", body: { items: state.tplDraft },
      });
      toast("草稿已保存", "ok");
      openTemplate(state.template.id);
    } catch (e) {
      if (e.data && e.data.details) renderTemplate(e.data.details);
      else handleApiError(e);
    }
  }

  async function tplPublish() {
    try {
      await api(`/api/templates/${state.template.id}/versions/${state.tplDraftVersionId}`, {
        method: "PUT", body: { items: state.tplDraft },
      });
      await api(`/api/templates/${state.template.id}/versions/${state.tplDraftVersionId}/publish`, { method: "POST" });
      toast("已发布并冻结", "ok");
      openTemplate(state.template.id);
    } catch (e) {
      if (e.data && e.data.details) renderTemplate(e.data.details);
      else handleApiError(e);
    }
  }

  /* ---------------- 检查单 ---------------- */
  async function openInstance(insId, silent) {
    try {
      const data = await api(`/api/instances/${insId}`);
      state.instance = data.instance;
      LS.set(`cache:ins:${insId}`, data.instance);
      state.view = "instance";
      renderInstance();
    } catch (e) {
      if (e instanceof OfflineError) {
        const cached = LS.get(`cache:ins:${insId}`, null);
        if (cached) { state.instance = cached; state.view = "instance"; renderInstance(); toast("离线查看缓存数据", ""); }
        else toast("离线且无缓存，无法打开", "error");
      } else if (!silent) handleApiError(e);
    }
  }

  const STATUS_LABEL = { pass: "通过", fail: "不通过", na: "不适用" };

  function renderInstance() {
    const ins = state.instance;
    const locked = ins.status === "signed";
    const pct = ins.progress.applicable ? Math.round((ins.progress.completed / ins.progress.applicable) * 100) : 0;
    $("#app").innerHTML = `
      <div class="view-title">
        <button class="btn ghost" onclick="App.back()">‹ 返回</button>
        <h1>${esc(ins.title)}</h1>
        <span class="badge ${ins.status}">${locked ? "已签署·只读" : "进行中"}</span>
        <div class="sub">${esc(ins.templateName)} v${ins.versionNo} · 机号 ${esc(ins.aircraft || "-")} · 创建 ${esc(ins.createdBy)} ${fmtTime(ins.createdAt)} · 修订号 r${ins.revision}${state.online ? "" : " · （离线缓存）"}</div>
      </div>
      <div class="card">
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="meta" style="margin-top:6px">完成 ${ins.progress.completed}/${ins.progress.applicable} · 未闭环缺陷 ${ins.progress.openDefects} · 签署 ${ins.signatures.length}/2</div>
      </div>
      <div class="card"><h2>检查项</h2>${ins.items.map((it) => itemHtml(it, locked)).join("")}</div>
      ${signHtml(ins, locked)}
      <div class="card"><h2>操作</h2><div class="btn-row">
        <button class="btn" onclick="App.exportInstance()">导出整包（含附件）</button>
        <button class="btn" onclick="App.showAudit()">审计轨迹</button>
        ${locked ? `<button class="btn danger" onclick="App.revokeModal()">撤销签署</button>` : ""}
      </div></div>`;
  }

  function itemHtml(it, locked) {
    const ins = state.instance;
    const open = state.openItems[it.code];
    const r = ins.results[it.code];
    const draft = LS.get(`draft:${ins.id}:${it.code}`, null);
    const cur = draft || r || {};
    const applicable = it.applicable;
    const depBlocked = it.unmetDependencies && it.unmetDependencies.length > 0;
    const canEdit = !locked && applicable && !depBlocked && state.online;
    const headStatus = r ? `<span class="badge ${r.status === "pass" ? "closed" : r.status === "fail" ? "open" : "draft"}">${STATUS_LABEL[r.status]}</span>` : (applicable ? '<span class="badge in_progress">待录入</span>' : '<span class="badge draft">不适用</span>');
    const defects = (it.defects || []).map((d) => defectHtml(d, locked)).join("");
    const attachments = ins.attachments.filter((a) => a.itemCode === it.code);
    return `<div class="item-card ${!applicable || depBlocked ? "locked" : ""}">
      <div class="item-head" onclick="App.toggleItem('${esc(it.code)}')">
        <span class="code">${esc(it.code)}</span><span class="title">${esc(it.title)}</span>${headStatus}<span>${open ? "▾" : "▸"}</span>
      </div>
      ${open ? `<div class="item-body">
        <div class="cond-note">${esc(it.category)} · ${esc(it.description || "")}</div>
        ${it.deps && it.deps.length ? `<div class="dep-note">前置依赖：${it.deps.map((d) => esc(d)).join("、")}${depBlocked ? "（未完成，暂不可录入）" : "（已满足）"}</div>` : ""}
        ${it.visibleWhen ? `<div class="cond-note">条件项：当 ${esc(it.visibleWhen.code)} 结果为 ${it.visibleWhen.in.map((s) => STATUS_LABEL[s]).join("/")} 时适用</div>` : ""}
        ${applicable ? `
        <div class="result-btns">
          ${["pass", "fail", "na"].map((s) => `<button class="${cur.status === s ? "sel-" + s : ""}" ${canEdit ? "" : "disabled"} onclick="App.setResult('${esc(it.code)}','${s}')">${STATUS_LABEL[s]}</button>`).join("")}
        </div>
        <label class="field"><span>测量值/参数</span><input type="text" value="${esc(cur.value || "")}" ${canEdit ? "" : "disabled"} oninput="App.draft('${esc(it.code)}','value',this.value)" onchange="App.saveItem('${esc(it.code)}')"></label>
        <label class="field"><span>备注</span><textarea ${canEdit ? "" : "disabled"} oninput="App.draft('${esc(it.code)}','notes',this.value)" onchange="App.saveItem('${esc(it.code)}')">${esc(cur.notes || "")}</textarea></label>
        <div>
          ${attachments.map((a) => `<span class="attach-chip">📎 <a href="javascript:App.downloadAttachment('${a.id}')">${esc(a.name)}</a> (${Math.round(a.size / 1024)}KB)${locked ? "" : ` <button onclick="App.removeAttachment('${a.id}')" title="删除">×</button>`}</span>`).join("")}
          ${!locked && state.online ? `<label class="btn small" style="margin-top:6px">上传附件<input type="file" style="display:none" onchange="App.uploadAttachment('${esc(it.code)}',this)"></label>` : ""}
        </div>
        ${defects}
        ${!locked && state.online ? `<button class="btn small danger" style="margin-top:8px" onclick="App.defectModal('${esc(it.code)}')">＋ 登记缺陷</button>` : ""}
        ` : `<div class="empty">该条件项当前不适用</div>`}
      </div>` : ""}
    </div>`;
  }

  function defectHtml(d, locked) {
    const ins = state.instance;
    const flow = d.history.map((h) => `<div>· ${fmtTime(h.at)} ${esc(h.by)}：${esc(actionLabel(h.action))} ${esc(h.note || "")}</div>`).join("");
    const canDispose = !locked && d.status === "open" && state.online && (state.user.roles.includes("engineer") || state.user.roles.includes("admin"));
    const canVerify = !locked && d.status === "disposed" && state.online && (state.user.roles.includes("inspector") || state.user.roles.includes("admin"));
    return `<div class="defect-box ${d.status === "closed" ? "closed" : ""}">
      <div class="desc">缺陷 · ${esc(d.description)} <span class="badge ${d.status}">${d.status === "open" ? "待处置" : d.status === "disposed" ? "待复检" : "已闭环"}</span></div>
      <div class="flow">${flow}</div>
      <div class="btn-row">
        ${canDispose ? `<button class="btn small" onclick="App.dispositionModal('${d.id}')">填写处置措施</button>` : ""}
        ${canVerify ? `<button class="btn small primary" onclick="App.verifyModal('${d.id}')">复检（须非处置人）</button>` : ""}
      </div>
    </div>`;
  }

  function actionLabel(a) {
    return { open: "登记缺陷", dispose: "处置", "verify-pass": "复检通过·闭环", "verify-reject": "复检不通过·重开" }[a] || a;
  }

  function signHtml(ins, locked) {
    const slots = [0, 1].map((i) => {
      const s = ins.signatures[i];
      return `<div class="sign-slot ${s ? "filled" : ""}">${s ? `✓ ${esc(s.userName)}<br><small>${fmtTime(s.at)}</small>` : `签署人 ${i + 1}<br><small>待确认</small>`}</div>`;
    }).join("");
    const blockers = ins.signBlockers || [];
    const revoked = (ins.revocations || []).map((r) => `<div class="audit-row"><span class="who">${esc(r.by)}</span> 撤销了签署（原因：${esc(r.reason)}）<span class="when">${fmtTime(r.at)}</span></div>`).join("");
    return `<div class="card"><h2>双人签署 ${locked ? "（已完成，检查单只读）" : ""}</h2>
      <div class="sign-slots">${slots}</div>
      ${!locked && blockers.length ? `<ul class="blocker-list">${blockers.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
      ${!locked ? `<button class="btn accent" ${state.online ? "" : "disabled"} onclick="App.signModal()">签署确认</button>` : ""}
      ${revoked ? `<h3 style="margin-top:12px">撤销记录</h3>${revoked}` : ""}
    </div>`;
  }

  /* ---------------- 检查单操作 ---------------- */
  function toggleItem(code) {
    state.openItems[code] = !state.openItems[code];
    renderInstance();
  }

  function draft(itemCode, field, value) {
    const ins = state.instance;
    const key = `draft:${ins.id}:${itemCode}`;
    const d = LS.get(key, {});
    d[field] = value;
    if (state.instance.results[itemCode] && !d.status) d.status = state.instance.results[itemCode].status;
    LS.set(key, d);
  }

  async function setResult(itemCode, status) {
    const ins = state.instance;
    const key = `draft:${ins.id}:${itemCode}`;
    const d = LS.get(key, {});
    d.status = status;
    LS.set(key, d);
    await saveItem(itemCode);
  }

  async function saveItem(itemCode) {
    const ins = state.instance;
    const key = `draft:${ins.id}:${itemCode}`;
    const d = LS.get(key, null);
    if (!d || !d.status) { if (d && !d.status) toast("请先选择 通过/不通过/不适用", "error"); return; }
    try {
      const updated = await saveResult(ins.id, itemCode, { status: d.status, value: d.value || "", notes: d.notes || "" });
      LS.del(key);
      if (updated) {
        state.instance = updated;
        LS.set(`cache:ins:${ins.id}`, updated);
        broadcastChanged(ins.id, updated.revision);
        renderInstance();
      } else {
        renderInstance(); // 离线：乐观更新已生效
      }
    } catch (e) { handleApiError(e, ins.id); }
  }

  async function uploadAttachment(itemCode, input) {
    const file = input.files[0];
    if (!file) return;
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
    const base64 = String(dataUrl).split(",")[1] || "";
    try {
      const data = await api(`/api/instances/${state.instance.id}/results/${encodeURIComponent(itemCode)}/attachments`, {
        method: "POST",
        body: { name: file.name, mime: file.type, data: base64, baseRevision: state.instance.revision },
      });
      state.instance = data.instance;
      broadcastChanged(state.instance.id, data.instance.revision);
      renderInstance();
      toast("附件已上传", "ok");
    } catch (e) { handleApiError(e, state.instance.id); }
  }

  async function downloadAttachment(attId) {
    try {
      const data = await api(`/api/instances/${state.instance.id}/attachments/${attId}`);
      const a = document.createElement("a");
      a.href = `data:${data.attachment.mime};base64,${data.attachment.data}`;
      a.download = data.attachment.name;
      a.click();
    } catch (e) { handleApiError(e); }
  }

  async function removeAttachment(attId) {
    try {
      const data = await api(`/api/instances/${state.instance.id}/attachments/${attId}`, {
        method: "DELETE", body: { baseRevision: state.instance.revision },
      });
      state.instance = data.instance;
      broadcastChanged(state.instance.id, data.instance.revision);
      renderInstance();
    } catch (e) { handleApiError(e, state.instance.id); }
  }

  /* ---------------- 缺陷 ---------------- */
  function defectModal(itemCode) {
    modal(`<h3>登记缺陷 · ${esc(itemCode)}</h3>
      <label class="field"><span>缺陷描述</span><textarea id="df-desc" placeholder="缺陷现象、位置、程度"></textarea></label>
      <div class="btn-row"><button class="btn primary" onclick="App.submitDefect('${esc(itemCode)}')">提交</button><button class="btn" onclick="App.closeModal()">取消</button></div>`);
  }

  async function submitDefect(itemCode) {
    try {
      const data = await api(`/api/instances/${state.instance.id}/defects`, {
        method: "POST",
        body: { itemCode, description: $("#df-desc").value, baseRevision: state.instance.revision },
      });
      state.instance = data.instance;
      broadcastChanged(state.instance.id, data.instance.revision);
      closeModal(); renderInstance(); toast("缺陷已登记", "ok");
    } catch (e) { handleApiError(e, state.instance.id); }
  }

  function dispositionModal(defectId) {
    modal(`<h3>填写处置措施</h3>
      <label class="field"><span>处置措施</span><textarea id="dp-text" placeholder="排故方案、更换件、参考手册章节"></textarea></label>
      <div class="btn-row"><button class="btn primary" onclick="App.submitDisposition('${defectId}')">提交处置</button><button class="btn" onclick="App.closeModal()">取消</button></div>`);
  }

  async function submitDisposition(defectId) {
    try {
      const data = await api(`/api/instances/${state.instance.id}/defects/${defectId}/disposition`, {
        method: "POST",
        body: { text: $("#dp-text").value, baseRevision: state.instance.revision },
      });
      state.instance = data.instance;
      broadcastChanged(state.instance.id, data.instance.revision);
      closeModal(); renderInstance(); toast("处置已提交，待他人复检", "ok");
    } catch (e) { handleApiError(e, state.instance.id); }
  }

  function verifyModal(defectId) {
    modal(`<h3>缺陷复检（须由非处置人执行）</h3>
      <label class="field"><span>复检备注</span><textarea id="vf-notes" placeholder="复检情况"></textarea></label>
      <div class="btn-row">
        <button class="btn primary" onclick="App.submitVerify('${defectId}','pass')">复检通过·闭环</button>
        <button class="btn danger" onclick="App.submitVerify('${defectId}','reject')">不通过·重新打开</button>
        <button class="btn" onclick="App.closeModal()">取消</button>
      </div>`);
  }

  async function submitVerify(defectId, result) {
    try {
      const data = await api(`/api/instances/${state.instance.id}/defects/${defectId}/verify`, {
        method: "POST",
        body: { result, notes: $("#vf-notes").value, baseRevision: state.instance.revision },
      });
      state.instance = data.instance;
      broadcastChanged(state.instance.id, data.instance.revision);
      closeModal(); renderInstance(); toast(result === "pass" ? "缺陷已闭环" : "缺陷已重新打开", "ok");
    } catch (e) { handleApiError(e, state.instance.id); }
  }

  /* ---------------- 签署 / 撤销 ---------------- */
  function signModal() {
    const ins = state.instance;
    modal(`<h3>签署确认（第 ${ins.signatures.length + 1} 位签署人，共需 2 位不同人员）</h3>
      <p class="meta" style="color:var(--muted);font-size:13px">请输入签署人本人账号口令。签署人须具备检验/管理角色，且不能与前一位签署人重复。</p>
      <label class="field"><span>签署人用户名</span><input id="sg-user" type="text" value="${esc(state.user.username)}"></label>
      <label class="field"><span>口令</span><input id="sg-pass" type="password"></label>
      <div class="btn-row"><button class="btn accent" onclick="App.submitSign()">确认签署</button><button class="btn" onclick="App.closeModal()">取消</button></div>`);
  }

  async function submitSign() {
    try {
      const data = await api(`/api/instances/${state.instance.id}/sign`, {
        method: "POST",
        body: { username: $("#sg-user").value.trim(), password: $("#sg-pass").value, baseRevision: state.instance.revision },
      });
      state.instance = data.instance;
      broadcastChanged(state.instance.id, data.instance.revision);
      closeModal(); renderInstance();
      toast(data.instance.status === "signed" ? "双人签署完成，检查单已锁定" : "第 1 位签署完成，待第 2 位签署", "ok");
    } catch (e) {
      if (e.data && e.data.blockers) {
        modal(`<h3>暂不能签署</h3><ul class="blocker-list">${e.data.blockers.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
          <div class="btn-row"><button class="btn" onclick="App.closeModal()">知道了</button></div>`);
      } else handleApiError(e, state.instance.id);
    }
  }

  function revokeModal() {
    modal(`<h3>撤销签署</h3>
      <p class="meta" style="color:var(--danger);font-size:13px">撤销后检查单恢复可编辑，原签署记录与撤销原因将永久保留在审计轨迹中。</p>
      <label class="field"><span>撤销原因（必填）</span><textarea id="rv-reason"></textarea></label>
      <div class="btn-row"><button class="btn danger" onclick="App.submitRevoke()">确认撤销</button><button class="btn" onclick="App.closeModal()">取消</button></div>`);
  }

  async function submitRevoke() {
    try {
      const data = await api(`/api/instances/${state.instance.id}/revoke`, {
        method: "POST",
        body: { reason: $("#rv-reason").value, baseRevision: state.instance.revision },
      });
      state.instance = data.instance;
      broadcastChanged(state.instance.id, data.instance.revision);
      closeModal(); renderInstance(); toast("已撤销签署并留痕", "ok");
    } catch (e) { handleApiError(e, state.instance.id); }
  }

  /* ---------------- 审计 / 导入导出 ---------------- */
  async function showAudit() {
    try {
      const data = await api(`/api/instances/${state.instance.id}/audit`);
      const rows = data.audits.map((a) => `<div class="audit-row"><span class="who">${esc(a.actorName)}</span> ${esc(a.action)} <span class="mono">${esc(JSON.stringify(a.detail))}</span><span class="when">${fmtTime(a.at)}</span></div>`).join("");
      modal(`<h3>审计轨迹</h3>${rows || '<div class="empty">暂无记录</div>'}<div class="btn-row" style="margin-top:10px"><button class="btn" onclick="App.closeModal()">关闭</button></div>`);
    } catch (e) { handleApiError(e); }
  }

  async function exportInstance() {
    try {
      const pkg = await api(`/api/instances/${state.instance.id}/export`);
      const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${state.instance.title || "检查单"}.aipkg.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast("已导出整包（含附件与校验和）", "ok");
    } catch (e) { handleApiError(e); }
  }

  async function importPackage(input) {
    const file = input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      let pkg;
      try { pkg = JSON.parse(text); } catch { toast("导入失败：文件不是合法 JSON，现有数据未受影响", "error"); return; }
      const data = await api("/api/packages/import", { method: "POST", body: pkg });
      toast(`导入成功：${data.title}`, "ok");
      loadDash();
    } catch (e) {
      toast(e.message + (e.data && e.data.details ? "：" + e.data.details.join("；") : ""), "error");
    } finally {
      input.value = "";
    }
  }

  /* ---------------- 新建 ---------------- */
  function newInstanceModal() {
    const versions = [];
    for (const t of state.templates) for (const v of t.versions) if (v.status === "published") versions.push({ t, v });
    if (!versions.length) { toast("暂无已发布的模板版本，请先发布模板", "error"); return; }
    modal(`<h3>新建检查单</h3>
      <label class="field"><span>模板版本（实例将绑定该版本，后续模板修改不影响）</span>
        <select id="ni-ver">${versions.map(({ t, v }) => `<option value="${v.id}">${esc(t.name)} · v${v.versionNo}</option>`).join("")}</select></label>
      <label class="field"><span>标题</span><input id="ni-title" type="text" placeholder="如：B-1234 航前检查"></label>
      <label class="field"><span>机号/注册号</span><input id="ni-ac" type="text" placeholder="如 B-1234"></label>
      <div class="btn-row"><button class="btn primary" onclick="App.submitNewInstance()">创建</button><button class="btn" onclick="App.closeModal()">取消</button></div>`);
  }

  async function submitNewInstance() {
    try {
      const data = await api("/api/instances", {
        method: "POST",
        body: { templateVersionId: $("#ni-ver").value, title: $("#ni-title").value, aircraft: $("#ni-ac").value },
      });
      closeModal();
      openInstance(data.instance.id);
    } catch (e) { handleApiError(e); }
  }

  function newTemplateModal() {
    modal(`<h3>新建检查模板</h3>
      <label class="field"><span>模板名称</span><input id="nt-name" type="text" placeholder="如 B737 航后检查单"></label>
      <label class="field"><span>ATA 章节</span><input id="nt-ata" type="text" placeholder="如 ATA 05/32"></label>
      <label class="field"><span>说明</span><input id="nt-desc" type="text"></label>
      <div class="btn-row"><button class="btn primary" onclick="App.submitNewTemplate()">创建</button><button class="btn" onclick="App.closeModal()">取消</button></div>`);
  }

  async function submitNewTemplate() {
    try {
      await api("/api/templates", {
        method: "POST",
        body: { name: $("#nt-name").value, ataChapter: $("#nt-ata").value, description: $("#nt-desc").value },
      });
      closeModal(); toast("模板已创建，请编辑检查项后发布", "ok");
      loadDash();
    } catch (e) { handleApiError(e); }
  }

  /* ---------------- 路由与启动 ---------------- */
  function back() { location.hash = "#/dash"; }

  function renderUserChip() {
    $("#user-chip").innerHTML = state.user
      ? `<span>${esc(state.user.displayName)} · ${esc(state.user.roles.join("/"))}</span><button onclick="App.logout()">退出</button>`
      : "";
  }

  async function boot() {
    renderNetStatus();
    renderUserChip();
    if (!state.token) { renderLogin(); return; }
    const hash = location.hash || "#/dash";
    if (hash.startsWith("#/ins/")) { await openInstance(hash.slice(6)); return; }
    if (hash.startsWith("#/tpl/")) { await openTemplate(hash.slice(6)); return; }
    state.view = "dash";
    await loadDash();
    syncPending();
  }

  window.addEventListener("hashchange", boot);
  window.addEventListener("online", () => { state.online = true; renderNetStatus(); toast("网络已恢复，正在同步…", "ok"); syncPending(); });
  window.addEventListener("offline", () => { state.online = false; renderNetStatus(); });

  /* ---------------- 暴露给内联事件 ---------------- */
  window.App = {
    closeModal, setConflict, doLogin, logout, back,
    switchTab(tab) { state.dashTab = tab; renderDash(); },
    openInstance, openTemplate, toggleItem, draft, setResult, saveItem,
    uploadAttachment, downloadAttachment, removeAttachment,
    defectModal, submitDefect, dispositionModal, submitDisposition, verifyModal, submitVerify,
    signModal, submitSign, revokeModal, submitRevoke,
    showAudit, exportInstance, importPackage,
    newInstanceModal, submitNewInstance, newTemplateModal, submitNewTemplate,
    newInstanceFromVersion(verId) {
      modal(`<h3>新建检查单</h3>
        <label class="field"><span>标题</span><input id="ni-title" type="text" placeholder="如：B-1234 航前检查"></label>
        <label class="field"><span>机号/注册号</span><input id="ni-ac" type="text"></label>
        <div class="btn-row"><button class="btn primary" onclick="App.submitNewInstanceFromVersion('${verId}')">创建</button><button class="btn" onclick="App.closeModal()">取消</button></div>`);
    },
    async submitNewInstanceFromVersion(verId) {
      try {
        const data = await api("/api/instances", {
          method: "POST",
          body: { templateVersionId: verId, title: $("#ni-title").value, aircraft: $("#ni-ac").value },
        });
        closeModal(); location.hash = `#/ins/${data.instance.id}`;
      } catch (e) { handleApiError(e); }
    },
    reloadCurrent() { setConflict(""); boot(); },
    exportAllHint() { toast("请打开具体检查单后使用「导出整包」", ""); },
    tplSet(idx, field, value) { state.tplDraft[idx][field] = value; },
    tplSetDeps(idx, value) { state.tplDraft[idx].deps = value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean); },
    tplSetCond(idx, code) { state.tplDraft[idx].visibleWhen = code ? { code, in: ["fail"] } : null; renderTemplate(); },
    tplSetCondVal(idx, val) { if (state.tplDraft[idx].visibleWhen) state.tplDraft[idx].visibleWhen.in = [val]; },
    tplAddItem() { state.tplDraft.push({ code: "", title: "", category: "通用", description: "", deps: [], visibleWhen: null }); renderTemplate(); },
    tplRemoveItem(idx) { state.tplDraft.splice(idx, 1); renderTemplate(); },
    tplSave, tplPublish,
    async tplNewVersion() {
      try {
        await api(`/api/templates/${state.template.id}/versions`, { method: "POST" });
        openTemplate(state.template.id);
      } catch (e) { handleApiError(e); }
    },
  };

  boot();
})();
