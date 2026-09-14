"use strict";
/**
 * 复现与回归测试（针对本轮修复的三个问题）：
 *  A. 检验账号不得提交工程师结果/附件（接口 403，复现原越权问题）
 *  B. 离线修改与他人修改同项：同步计划必须判冲突、保留双方，禁止静默覆盖；
 *     用户明示选择后才提交（复现原"联网同步覆盖对方"问题）
 *  C. 离线队列合并渲染（applyOps）：刷新后离线修改仍可见（复现原"刷新丢失"问题）
 *  D. 回归：模板冻结、缺陷闭环、双人签署、整包回滚不受影响
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hxwl-reg-"));
const app = require("../server/index.js");
const Offline = require("../public/offline.js");

let server;
let base;
const tokens = {};

async function api(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}

async function login(username, password) {
  const r = await api("POST", "/api/auth/login", { body: { username, password } });
  assert.equal(r.status, 200);
  return r.data.token;
}

async function makeInstance(items) {
  const t = await api("POST", "/api/templates", { token: tokens.admin, body: { name: "回归模板" + Math.random() } });
  const tplId = t.data.template.id;
  const verId = t.data.template.versions[0].id;
  await api("PUT", `/api/templates/${tplId}/versions/${verId}`, { token: tokens.admin, body: { items } });
  await api("POST", `/api/templates/${tplId}/versions/${verId}/publish`, { token: tokens.admin });
  const ins = await api("POST", "/api/instances", { token: tokens.wang, body: { templateVersionId: verId, title: "回归检查单" } });
  return ins.data.instance;
}

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  tokens.admin = await login("admin", "admin123");
  tokens.wang = await login("wang", "wang123");
  tokens.li = await login("li", "li123");
  tokens.zhao = await login("zhao", "zhao123");
  tokens.chen = await login("chen", "chen123");
});

test.after(() => server.close());

/* ---------- A. 检验账号不得提交工程师结果/附件 ---------- */

test("越权复现：检验账号提交结果/附件一律 403，工程师正常", async () => {
  const ins = await makeInstance([{ code: "A", title: "甲", deps: [] }]);

  // 检验(zhao)提交结果 → 403
  const r1 = await api("PUT", `/api/instances/${ins.id}/results/A`, {
    token: tokens.zhao, body: { status: "pass", baseRevision: ins.revision },
  });
  assert.equal(r1.status, 403, "检验不应能录入结果");

  // 检验上传附件 → 403
  const r2 = await api("POST", `/api/instances/${ins.id}/results/A/attachments`, {
    token: tokens.zhao, body: { name: "x.txt", data: Buffer.from("x").toString("base64"), baseRevision: ins.revision },
  });
  assert.equal(r2.status, 403, "检验不应能上传附件");

  // 工程师录入正常
  const r3 = await api("PUT", `/api/instances/${ins.id}/results/A`, {
    token: tokens.wang, body: { status: "pass", value: "ok", baseRevision: ins.revision },
  });
  assert.equal(r3.status, 200);
  const rev = r3.data.instance.revision;

  // 工程师上传附件正常，检验删除附件 → 403
  const r4 = await api("POST", `/api/instances/${ins.id}/results/A/attachments`, {
    token: tokens.wang, body: { name: "photo.txt", data: Buffer.from("img").toString("base64"), baseRevision: rev },
  });
  assert.equal(r4.status, 201);
  const attId = r4.data.instance.attachments[0].id;
  const r5 = await api("DELETE", `/api/instances/${ins.id}/attachments/${attId}`, {
    token: tokens.zhao, body: { baseRevision: r4.data.instance.revision },
  });
  assert.equal(r5.status, 403, "检验不应能删除附件");

  // 检验的正当权限不受影响：可复检、可签署（签署资格在 sign 接口校验签署人）
  const me = await api("GET", "/api/auth/me", { token: tokens.zhao });
  assert.ok(me.data.user.roles.includes("inspector"));
});

/* ---------- B. 离线冲突：保留双方、明示选择、禁止静默覆盖 ---------- */

test("planSync：基线比对三种分支（apply / noop / conflict）", () => {
  const serverIns = {
    id: "ins1",
    results: {
      KEEP: { status: "pass", value: "1", notes: "" },      // 与基线一致 → apply
      SAME: { status: "fail", value: "2", notes: "x" },     // 与离线值一致 → noop
      CLASH: { status: "na", value: "", notes: "他人改的" }, // 被他人改动 → conflict
    },
  };
  const ops = [
    { insId: "ins1", itemCode: "KEEP", status: "fail", value: "9", notes: "", baseResult: { status: "pass", value: "1", notes: "" } },
    { insId: "ins1", itemCode: "SAME", status: "fail", value: "2", notes: "x", baseResult: null },
    { insId: "ins1", itemCode: "CLASH", status: "pass", value: "5", notes: "离线改的", baseResult: { status: "pass", value: "", notes: "" } },
  ];
  const plan = Offline.planSync(ops, serverIns);
  assert.deepEqual(plan.apply.map((o) => o.itemCode), ["KEEP"]);
  assert.deepEqual(plan.noop.map((o) => o.itemCode), ["SAME"]);
  assert.deepEqual(plan.conflict.map((c) => c.op.itemCode), ["CLASH"]);
  // 冲突必须同时保留双方内容
  assert.equal(plan.conflict[0].server.status, "na");
  assert.equal(plan.conflict[0].op.status, "pass");
});

test("离线修改与他人修改同项：同步不覆盖，选择后才生效", async () => {
  const ins = await makeInstance([{ code: "A", title: "甲", deps: [] }]);
  // 王工在线录入 A=pass（这成为离线编辑的基线）
  const r1 = await api("PUT", `/api/instances/${ins.id}/results/A`, {
    token: tokens.wang, body: { status: "pass", value: "1", notes: "", baseRevision: ins.revision },
  });
  assert.equal(r1.status, 200);
  const baseResult = { status: "pass", value: "1", notes: "" };

  // 王工"离线"修改 A=fail（入队，未提交）；同时李工在线把 A 改为 na
  const offlineOp = { insId: ins.id, itemCode: "A", status: "fail", value: "9", notes: "离线改", baseResult, at: Date.now() };
  const r2 = await api("PUT", `/api/instances/${ins.id}/results/A`, {
    token: tokens.li, body: { status: "na", value: "", notes: "李工在线改", baseRevision: r1.data.instance.revision },
  });
  assert.equal(r2.status, 200);

  // 王工联网同步：拉取服务器现值 → 计划必须判为冲突
  const fresh = (await api("GET", `/api/instances/${ins.id}`, { token: tokens.wang })).data.instance;
  const plan = Offline.planSync([offlineOp], fresh);
  assert.equal(plan.apply.length, 0, "他人已改动，不得直接提交");
  assert.equal(plan.conflict.length, 1);

  // 关键断言：服务器仍是李工的值，未被静默覆盖
  const after = (await api("GET", `/api/instances/${ins.id}`, { token: tokens.wang })).data.instance;
  assert.equal(after.results.A.status, "na");
  assert.equal(after.results.A.notes, "李工在线改");

  // 用户选择"保留对方" → 服务器不变
  // （无需请求）再验证一次
  // 用户选择"采用我的" → 用最新修订号提交，服务器变为离线值
  const r3 = await api("PUT", `/api/instances/${ins.id}/results/A`, {
    token: tokens.wang,
    body: { status: offlineOp.status, value: offlineOp.value, notes: offlineOp.notes, baseRevision: after.revision },
  });
  assert.equal(r3.status, 200);
  assert.equal(r3.data.instance.results.A.status, "fail");
  assert.equal(r3.data.instance.results.A.value, "9");
});

test("签署后离线修改不得提交：转冲突保留，不静默丢弃", async () => {
  const ins = await makeInstance([{ code: "A", title: "甲", deps: [] }]);
  let cur = (await api("PUT", `/api/instances/${ins.id}/results/A`, {
    token: tokens.wang, body: { status: "pass", baseRevision: ins.revision },
  })).data.instance;
  // 双人签署
  cur = (await api("POST", `/api/instances/${ins.id}/sign`, { token: tokens.zhao, body: { username: "zhao", password: "zhao123", baseRevision: cur.revision } })).data.instance;
  const s2 = await api("POST", `/api/instances/${ins.id}/sign`, { token: tokens.chen, body: { username: "chen", password: "chen123", baseRevision: cur.revision } });
  assert.equal(s2.data.instance.status, "signed");

  // 模拟同步队列中残留的离线修改：提交应被 423 拒绝（客户端据此转冲突，绝不静默覆盖）
  const attempt = await api("PUT", `/api/instances/${ins.id}/results/A`, {
    token: tokens.wang, body: { status: "fail", baseRevision: s2.data.instance.revision },
  });
  assert.equal(attempt.status, 423);
  const after = (await api("GET", `/api/instances/${ins.id}`, { token: tokens.admin })).data.instance;
  assert.equal(after.results.A.status, "pass", "签署后任何修改都不得生效");
});

/* ---------- C. 离线队列合并渲染（刷新保留） ---------- */

test("applyOps：缓存实例叠加离线队列后离线修改可见", () => {
  const cached = {
    id: "ins1",
    results: { A: { status: "pass", value: "1", notes: "" } },
  };
  const ops = [
    { insId: "ins1", itemCode: "A", status: "fail", value: "9", notes: "离线改", at: 1 },
    { insId: "ins1", itemCode: "B", status: "na", value: "", notes: "", at: 2 },
    { insId: "other", itemCode: "C", status: "pass", at: 3 }, // 其他实例的队列不应混入
  ];
  const merged = Offline.applyOps(cached, ops);
  assert.equal(merged.results.A.status, "fail", "离线修改应覆盖显示");
  assert.equal(merged.results.A.offline, true);
  assert.equal(merged.results.B.status, "na", "离线新增的项也应可见");
  assert.equal(merged.results.C, undefined);
  // 原缓存对象不被修改
  assert.equal(cached.results.A.status, "pass");
});

/* ---------- D. 回归：核心机制不受影响 ---------- */

test("回归：模板冻结 / 缺陷闭环 / 双人签署 / 整包回滚", async () => {
  // 模板冻结
  const t = await api("POST", "/api/templates", { token: tokens.admin, body: { name: "冻结回归" } });
  const tplId = t.data.template.id;
  const verId = t.data.template.versions[0].id;
  await api("PUT", `/api/templates/${tplId}/versions/${verId}`, { token: tokens.admin, body: { items: [{ code: "A", title: "甲", deps: [] }] } });
  await api("POST", `/api/templates/${tplId}/versions/${verId}/publish`, { token: tokens.admin });
  const frozen = await api("PUT", `/api/templates/${tplId}/versions/${verId}`, { token: tokens.admin, body: { items: [{ code: "B", title: "乙", deps: [] }] } });
  assert.equal(frozen.status, 423);

  // 缺陷闭环 + 双人签署
  const ins = await makeInstance([{ code: "A", title: "甲", deps: [] }]);
  let cur = (await api("PUT", `/api/instances/${ins.id}/results/A`, { token: tokens.wang, body: { status: "fail", baseRevision: ins.revision } })).data.instance;
  cur = (await api("POST", `/api/instances/${ins.id}/defects`, { token: tokens.wang, body: { itemCode: "A", description: "回归缺陷", baseRevision: cur.revision } })).data.instance;
  const defId = cur.defects[0].id;
  cur = (await api("POST", `/api/instances/${ins.id}/defects/${defId}/disposition`, { token: tokens.wang, body: { text: "已处理", baseRevision: cur.revision } })).data.instance;
  cur = (await api("POST", `/api/instances/${ins.id}/defects/${defId}/verify`, { token: tokens.zhao, body: { result: "pass", baseRevision: cur.revision } })).data.instance;
  assert.equal(cur.defects[0].status, "closed");
  cur = (await api("POST", `/api/instances/${ins.id}/sign`, { token: tokens.zhao, body: { username: "zhao", password: "zhao123", baseRevision: cur.revision } })).data.instance;
  cur = (await api("POST", `/api/instances/${ins.id}/sign`, { token: tokens.chen, body: { username: "chen", password: "chen123", baseRevision: cur.revision } })).data.instance;
  assert.equal(cur.status, "signed");

  // 整包导出 → 损坏导入回滚
  const exp = await api("GET", `/api/instances/${ins.id}/export`, { token: tokens.admin });
  const before = (await api("GET", "/api/instances", { token: tokens.admin })).data.instances.length;
  const bad = JSON.parse(JSON.stringify(exp.data));
  bad.payload.instance.title = "损坏";
  const imp = await api("POST", "/api/packages/import", { token: tokens.admin, body: bad });
  assert.equal(imp.status, 400);
  const after = (await api("GET", "/api/instances", { token: tokens.admin })).data.instances.length;
  assert.equal(after, before, "损坏包导入不得改变数据");
});
