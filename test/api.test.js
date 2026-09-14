"use strict";
/**
 * 端到端 API 测试：
 *  1. 依赖循环检测（保存/发布拒绝循环依赖）
 *  2. 越权防护（角色校验、自检自复禁止、未登录 401）
 *  3. 并发签署（同一修订号并发只有一方成功，禁止重复签署）
 *  4. 签署前置（未完成依赖/未闭环缺陷不得签署）、签后只读、撤销留痕
 *  5. 整包导入导出（含附件）、损坏包导入失败且原数据不动（回滚）
 *  6. 乐观锁冲突（过期修订号 409）
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// 独立数据目录，避免污染开发数据
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hxwl-test-"));
const app = require("../server/index.js");

let server;
let base;
const tokens = {};

async function api(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 空响应 */ }
  return { status: res.status, data };
}

async function login(username, password) {
  const r = await api("POST", "/api/auth/login", { body: { username, password } });
  assert.equal(r.status, 200, `登录失败: ${username}`);
  return r.data.token;
}

/** 建一个已发布模板 + 检查单；items 可定制 */
async function makeInstance(items, { withDefect } = {}) {
  const t = await api("POST", "/api/templates", { token: tokens.admin, body: { name: "测试模板" + Math.random(), ataChapter: "ATA 32" } });
  const tplId = t.data.template.id;
  const verId = t.data.template.versions[0].id;
  const put = await api("PUT", `/api/templates/${tplId}/versions/${verId}`, { token: tokens.admin, body: { items } });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const pub = await api("POST", `/api/templates/${tplId}/versions/${verId}/publish`, { token: tokens.admin });
  assert.equal(pub.status, 200);
  const ins = await api("POST", "/api/instances", { token: tokens.wang, body: { templateVersionId: verId, title: "测试检查单", aircraft: "B-TEST" } });
  assert.equal(ins.status, 201);
  return ins.data.instance;
}

async function fillResult(insId, itemCode, status, revision) {
  return api("PUT", `/api/instances/${insId}/results/${itemCode}`, {
    token: tokens.wang,
    body: { status, value: "1", notes: "", baseRevision: revision },
  });
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

/* ---------- 1. 依赖循环 ---------- */

test("依赖循环：保存与发布均被拒绝并给出循环路径", async () => {
  const t = await api("POST", "/api/templates", { token: tokens.admin, body: { name: "循环模板" } });
  const { id: tplId, versions } = t.data.template;
  const verId = versions[0].id;
  const cyclic = [
    { code: "A", title: "甲", deps: ["B"] },
    { code: "B", title: "乙", deps: ["C"] },
    { code: "C", title: "丙", deps: ["A"] },
  ];
  const r = await api("PUT", `/api/templates/${tplId}/versions/${verId}`, { token: tokens.admin, body: { items: cyclic } });
  assert.equal(r.status, 422);
  assert.match(r.data.details.join(" "), /循环/);
  assert.match(r.data.details.join(" "), /A/);

  // 自依赖同样拒绝
  const self = await api("PUT", `/api/templates/${tplId}/versions/${verId}`, {
    token: tokens.admin, body: { items: [{ code: "X", title: "x", deps: ["X"] }] },
  });
  assert.equal(self.status, 422);

  // 无环 → 通过并发布
  const ok = await api("PUT", `/api/templates/${tplId}/versions/${verId}`, {
    token: tokens.admin,
    body: { items: [{ code: "A", title: "甲", deps: [] }, { code: "B", title: "乙", deps: ["A"] }] },
  });
  assert.equal(ok.status, 200);
  const pub = await api("POST", `/api/templates/${tplId}/versions/${verId}/publish`, { token: tokens.admin });
  assert.equal(pub.status, 200);
  assert.equal(pub.data.version.status, "published");

  // 发布后冻结：再改 → 423
  const frozen = await api("PUT", `/api/templates/${tplId}/versions/${verId}`, {
    token: tokens.admin, body: { items: [{ code: "A", title: "改", deps: [] }] },
  });
  assert.equal(frozen.status, 423);
});

/* ---------- 2. 越权 ---------- */

test("越权：角色与登录态校验", async () => {
  // 未登录
  const noAuth = await api("GET", "/api/instances");
  assert.equal(noAuth.status, 401);

  // 工程师不能建模板/发布
  const mk = await api("POST", "/api/templates", { token: tokens.wang, body: { name: "越权模板" } });
  assert.equal(mk.status, 403);

  // 工程师不能复检（复检需 inspector/admin）
  const items = [{ code: "A", title: "甲", deps: [] }];
  const ins = await makeInstance(items);
  await fillResult(ins.id, "A", "fail", ins.revision);
  let cur = (await api("GET", `/api/instances/${ins.id}`, { token: tokens.wang })).data.instance;
  const def = await api("POST", `/api/instances/${ins.id}/defects`, { token: tokens.wang, body: { itemCode: "A", description: "测试缺陷", baseRevision: cur.revision } });
  assert.equal(def.status, 201);
  cur = def.data.instance;
  const defId = cur.defects[0].id;

  const disp = await api("POST", `/api/instances/${ins.id}/defects/${defId}/disposition`, { token: tokens.wang, body: { text: "已更换", baseRevision: cur.revision } });
  assert.equal(disp.status, 200);
  cur = disp.data.instance;

  // 处置人自己复检 → 422（禁止自检自复）
  const selfVerify = await api("POST", `/api/instances/${ins.id}/defects/${defId}/verify`, { token: tokens.wang, body: { result: "pass", baseRevision: cur.revision } });
  assert.equal(selfVerify.status, 403); // wang 是 engineer，无复检角色
  // admin 处置后自己复检 → 422（同人）
  const ins2 = await makeInstance(items);
  await fillResult(ins2.id, "A", "fail", ins2.revision);
  let cur2 = (await api("GET", `/api/instances/${ins2.id}`, { token: tokens.admin })).data.instance;
  const def2 = await api("POST", `/api/instances/${ins2.id}/defects`, { token: tokens.admin, body: { itemCode: "A", description: "d", baseRevision: cur2.revision } });
  const def2Id = def2.data.instance.defects[0].id;
  const disp2 = await api("POST", `/api/instances/${ins2.id}/defects/${def2Id}/disposition`, { token: tokens.admin, body: { text: "x", baseRevision: def2.data.instance.revision } });
  const samePerson = await api("POST", `/api/instances/${ins2.id}/defects/${def2Id}/verify`, { token: tokens.admin, body: { result: "pass", baseRevision: disp2.data.instance.revision } });
  assert.equal(samePerson.status, 422);
  assert.match(samePerson.data.error, /不同/);

  // 工程师账号不能作为签署人
  const ins3 = await makeInstance(items);
  await fillResult(ins3.id, "A", "pass", ins3.revision);
  const cur3 = (await api("GET", `/api/instances/${ins3.id}`, { token: tokens.zhao })).data.instance;
  const engSign = await api("POST", `/api/instances/${ins3.id}/sign`, { token: tokens.zhao, body: { username: "wang", password: "wang123", baseRevision: cur3.revision } });
  assert.equal(engSign.status, 403);
});

/* ---------- 3. 签署前置 / 双人签署 / 签后只读 / 撤销 ---------- */

test("签署前置：未完成依赖与未闭环缺陷阻止签署；条件项逻辑正确", async () => {
  const items = [
    { code: "A", title: "甲", deps: [] },
    { code: "B", title: "乙", deps: ["A"] },
    { code: "C", title: "条件项", deps: [], visibleWhen: { code: "A", in: ["fail"] } },
  ];
  const ins = await makeInstance(items);

  // 依赖未满足：直接录 B → 422
  const early = await fillResult(ins.id, "B", "pass", ins.revision);
  assert.equal(early.status, 422);
  assert.match(early.data.error, /前置依赖/);

  // A=pass → 条件项 C 不适用；只录 A、B 即可签署
  let cur = (await fillResult(ins.id, "A", "pass", ins.revision)).data.instance;
  cur = (await fillResult(ins.id, "B", "pass", cur.revision)).data.instance;
  assert.equal(cur.signBlockers.length, 0, JSON.stringify(cur.signBlockers));

  // 登记缺陷 → 阻止签署
  const def = await api("POST", `/api/instances/${ins.id}/defects`, { token: tokens.wang, body: { itemCode: "A", description: "蒙皮划痕", baseRevision: cur.revision } });
  cur = def.data.instance;
  const blocked = await api("POST", `/api/instances/${ins.id}/sign`, { token: tokens.zhao, body: { username: "zhao", password: "zhao123", baseRevision: cur.revision } });
  assert.equal(blocked.status, 422);
  assert.match(blocked.data.blockers.join(" "), /未闭环缺陷/);

  // 处置 → 他人复检闭环
  const defId = cur.defects[0].id;
  const disp = await api("POST", `/api/instances/${ins.id}/defects/${defId}/disposition`, { token: tokens.wang, body: { text: "已打磨修复", baseRevision: cur.revision } });
  cur = disp.data.instance;
  const ver = await api("POST", `/api/instances/${ins.id}/defects/${defId}/verify`, { token: tokens.zhao, body: { result: "pass", baseRevision: cur.revision } });
  assert.equal(ver.status, 200);
  cur = ver.data.instance;
  assert.equal(cur.defects[0].status, "closed");
});

test("条件项：A=fail 时 C 变为必录项，未录则阻止签署", async () => {
  const items = [
    { code: "A", title: "甲", deps: [] },
    { code: "C", title: "条件项", deps: [], visibleWhen: { code: "A", in: ["fail"] } },
  ];
  const ins = await makeInstance(items);
  let cur = (await fillResult(ins.id, "A", "fail", ins.revision)).data.instance;
  const blocked = await api("POST", `/api/instances/${ins.id}/sign`, { token: tokens.zhao, body: { username: "zhao", password: "zhao123", baseRevision: cur.revision } });
  assert.equal(blocked.status, 422);
  assert.match(blocked.data.blockers.join(" "), /C/);
  cur = (await fillResult(ins.id, "C", "pass", cur.revision)).data.instance;
  assert.equal(cur.signBlockers.length, 0);
});

test("双人签署：两名不同人员确认；签后只读；撤销留痕", async () => {
  const items = [{ code: "A", title: "甲", deps: [] }];
  const ins = await makeInstance(items);
  let cur = (await fillResult(ins.id, "A", "pass", ins.revision)).data.instance;

  // 第一位签署
  let r = await api("POST", `/api/instances/${ins.id}/sign`, { token: tokens.zhao, body: { username: "zhao", password: "zhao123", baseRevision: cur.revision } });
  assert.equal(r.status, 200);
  cur = r.data.instance;
  assert.equal(cur.signatures.length, 1);
  assert.equal(cur.status, "in_progress");

  // 同一人不能重复签署
  r = await api("POST", `/api/instances/${ins.id}/sign`, { token: tokens.zhao, body: { username: "zhao", password: "zhao123", baseRevision: cur.revision } });
  assert.equal(r.status, 422);
  assert.match(r.data.error, /不同人员|重复/);

  // 第二位（不同人）→ signed
  r = await api("POST", `/api/instances/${ins.id}/sign`, { token: tokens.chen, body: { username: "chen", password: "chen123", baseRevision: cur.revision } });
  assert.equal(r.status, 200);
  cur = r.data.instance;
  assert.equal(cur.status, "signed");
  assert.equal(cur.signatures.length, 2);

  // 签后只读
  const edit = await fillResult(ins.id, "A", "fail", cur.revision);
  assert.equal(edit.status, 423);
  const thirdSign = await api("POST", `/api/instances/${ins.id}/sign`, { token: tokens.zhao, body: { username: "zhao", password: "zhao123", baseRevision: cur.revision } });
  assert.equal(thirdSign.status, 423);

  // 撤销必须填原因
  const noReason = await api("POST", `/api/instances/${ins.id}/revoke`, { token: tokens.zhao, body: { reason: "", baseRevision: cur.revision } });
  assert.equal(noReason.status, 422);

  // 工程师不能撤销（越权）
  const engRevoke = await api("POST", `/api/instances/${ins.id}/revoke`, { token: tokens.wang, body: { reason: "x", baseRevision: cur.revision } });
  assert.equal(engRevoke.status, 403);

  // 正常撤销 → 留痕
  const revoke = await api("POST", `/api/instances/${ins.id}/revoke`, { token: tokens.zhao, body: { reason: "发现漏检项，需重新检查", baseRevision: cur.revision } });
  assert.equal(revoke.status, 200);
  cur = revoke.data.instance;
  assert.equal(cur.status, "in_progress");
  assert.equal(cur.signatures.length, 0);
  assert.equal(cur.revocations.length, 1);
  assert.equal(cur.revocations[0].reason, "发现漏检项，需重新检查");
  assert.equal(cur.revocations[0].revokedSignatures.length, 2);

  // 审计轨迹包含完整链路
  const audits = (await api("GET", `/api/instances/${ins.id}/audit`, { token: tokens.admin })).data.audits;
  const actions = audits.map((a) => a.action);
  for (const expect of ["instance.create", "instance.result", "instance.sign", "instance.revoke"]) {
    assert.ok(actions.includes(expect), `审计缺少 ${expect}`);
  }
  const revokeAudit = audits.find((a) => a.action === "instance.revoke");
  assert.match(revokeAudit.detail.reason, /漏检/);
});

/* ---------- 4. 并发签署 ---------- */

test("并发签署：同一修订号并发请求只有一方成功，绝不重复签署", async () => {
  const items = [{ code: "A", title: "甲", deps: [] }];
  const ins = await makeInstance(items);
  const cur = (await fillResult(ins.id, "A", "pass", ins.revision)).data.instance;

  // 两位检验员基于同一修订号同时签署
  const [r1, r2] = await Promise.all([
    api("POST", `/api/instances/${ins.id}/sign`, { token: tokens.zhao, body: { username: "zhao", password: "zhao123", baseRevision: cur.revision } }),
    api("POST", `/api/instances/${ins.id}/sign`, { token: tokens.chen, body: { username: "chen", password: "chen123", baseRevision: cur.revision } }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], `并发签署应一成功一冲突，实际 ${statuses}`);

  const after = (await api("GET", `/api/instances/${ins.id}`, { token: tokens.admin })).data.instance;
  assert.equal(after.signatures.length, 1, "并发下只能产生一条签名");

  // 用最新修订号完成第二签 → signed
  const r3 = await api("POST", `/api/instances/${ins.id}/sign`, { token: tokens.chen, body: { username: "chen", password: "chen123", baseRevision: after.revision } });
  assert.equal(r3.status, 200);
  assert.equal(r3.data.instance.status, "signed");
  assert.equal(r3.data.instance.signatures.length, 2);
});

/* ---------- 5. 乐观锁 ---------- */

test("乐观锁：过期修订号修改返回 409", async () => {
  const items = [{ code: "A", title: "甲", deps: [] }];
  const ins = await makeInstance(items);
  const r1 = await fillResult(ins.id, "A", "pass", ins.revision);
  assert.equal(r1.status, 200);
  // 再用旧修订号 → 409
  const stale = await fillResult(ins.id, "A", "fail", ins.revision);
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /刷新/);
});

/* ---------- 6. 整包导入导出 / 失败回滚 ---------- */

test("导出含附件整包 → 导入成功；损坏包导入失败且原数据不动", async () => {
  const items = [{ code: "A", title: "甲", deps: [] }];
  const ins = await makeInstance(items);
  let cur = (await fillResult(ins.id, "A", "pass", ins.revision)).data.instance;

  // 上传附件
  const attach = await api("POST", `/api/instances/${ins.id}/results/A/attachments`, {
    token: tokens.wang,
    body: { name: "photo.txt", mime: "text/plain", data: Buffer.from("hello-attachment").toString("base64"), baseRevision: cur.revision },
  });
  assert.equal(attach.status, 201);
  cur = attach.data.instance;

  // 导出
  const exp = await api("GET", `/api/instances/${ins.id}/export`, { token: tokens.admin });
  assert.equal(exp.status, 200);
  assert.equal(exp.data.format, "aipkg@1");
  assert.ok(exp.data.checksum);
  assert.equal(exp.data.payload.attachments.length, 1);

  const countBefore = (await api("GET", "/api/instances", { token: tokens.admin })).data.instances.length;

  // 1) 正常导入 → 新实例，附件随行
  const imp = await api("POST", "/api/packages/import", { token: tokens.admin, body: exp.data });
  assert.equal(imp.status, 201, JSON.stringify(imp.data));
  const imported = (await api("GET", `/api/instances/${imp.data.instanceId}`, { token: tokens.admin })).data.instance;
  assert.equal(imported.attachments.length, 1);
  assert.equal(imported.results.A.status, "pass");
  assert.notEqual(imported.id, ins.id);

  // 2) 篡改内容（校验和不匹配）→ 400，数据不动
  const tampered = JSON.parse(JSON.stringify(exp.data));
  tampered.payload.instance.title = "被篡改的标题";
  const bad1 = await api("POST", "/api/packages/import", { token: tokens.admin, body: tampered });
  assert.equal(bad1.status, 400);
  assert.match(bad1.data.error, /未受影响/);

  // 3) 缺字段 → 400
  const bad2 = await api("POST", "/api/packages/import", { token: tokens.admin, body: { format: "aipkg@1" } });
  assert.equal(bad2.status, 400);

  // 4) 完全不是包 → 400
  const bad3 = await api("POST", "/api/packages/import", { token: tokens.admin, body: { hello: "world" } });
  assert.equal(bad3.status, 400);

  // 原数据保持不变：实例数只增加了正常导入的 1 个；原检查单内容未被污染
  const listAfter = (await api("GET", "/api/instances", { token: tokens.admin })).data.instances;
  assert.equal(listAfter.length, countBefore + 1);
  const original = (await api("GET", `/api/instances/${ins.id}`, { token: tokens.admin })).data.instance;
  assert.equal(original.revision, cur.revision);
  assert.equal(original.results.A.status, "pass");
  assert.equal(original.title, ins.title);
});

test("实例绑定原模板版本：模板发新版后旧实例不受影响", async () => {
  const t = await api("POST", "/api/templates", { token: tokens.admin, body: { name: "版本绑定模板" } });
  const tplId = t.data.template.id;
  const v1 = t.data.template.versions[0].id;
  await api("PUT", `/api/templates/${tplId}/versions/${v1}`, { token: tokens.admin, body: { items: [{ code: "A", title: "甲", deps: [] }] } });
  await api("POST", `/api/templates/${tplId}/versions/${v1}/publish`, { token: tokens.admin });
  const ins = await api("POST", "/api/instances", { token: tokens.wang, body: { templateVersionId: v1, title: "绑定v1" } });
  assert.equal(ins.status, 201);

  // 发布 v2（加了新项）
  const v2res = await api("POST", `/api/templates/${tplId}/versions`, { token: tokens.admin });
  const v2 = v2res.data.version.id;
  await api("PUT", `/api/templates/${tplId}/versions/${v2}`, { token: tokens.admin, body: { items: [{ code: "A", title: "甲", deps: [] }, { code: "B", title: "新增项", deps: [] }] } });
  await api("POST", `/api/templates/${tplId}/versions/${v2}/publish`, { token: tokens.admin });

  // 旧实例仍是 v1 的 1 个检查项
  const view = (await api("GET", `/api/instances/${ins.data.instance.id}`, { token: tokens.wang })).data.instance;
  assert.equal(view.versionNo, 1);
  assert.equal(view.items.length, 1);
});
