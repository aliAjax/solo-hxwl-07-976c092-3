/**
 * 真实浏览器端到端验证（桌面 + 手机视口）：
 *  场景1 桌面全流程：登录→建单→录入→条件项触发→检验角色只读
 *  场景2 离线：断网录入→断网刷新仍在→联网自动同步（复现原"刷新丢失/禁用录入"）
 *  场景3 冲突：离线修改+他人在线改同项→同步弹冲突→保留双方→明示选择后才生效（复现原"静默覆盖"）
 *  场景4 手机视口：完整走查录入→双人签署→签后只读
 * 运行：npm run e2e（需先 npx playwright install chromium）
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert";

// Chromium 系统库（免 root 本地解压）；若系统已具备则无影响
if (!process.env.LD_LIBRARY_PATH) {
  process.env.LD_LIBRARY_PATH = "/tmp/chromelibs/root/lib/aarch64-linux-gnu:/tmp/chromelibs/root/usr/lib/aarch64-linux-gnu";
}

const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
function ok(name) { results.push(name); console.log(`  ✔ ${name}`); }

async function api(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function loginToken(u, p) { return (await api("POST", "/api/auth/login", { body: { username: u, password: p } })).data.token; }

function watch(page, tag) {
  page.on("pageerror", (e) => console.log(`[pageerror:${tag}]`, e.message));
  page.on("console", (m) => { if (m.type() === "error") console.log(`[console:${tag}]`, m.text()); });
  page.on("requestfailed", (r) => console.log(`[reqfail:${tag}]`, r.url(), r.failure()?.errorText));
  page.on("response", (r) => { if (r.status() === 401) console.log(`[401:${tag}]`, r.url()); });
}

async function uiLogin(page, u, p) {
  await page.goto(BASE);
  await page.fill("#lg-user", u);
  await page.fill("#lg-pass", p);
  await page.click("text=登 录");
  await page.waitForSelector(".tabs");
}

/** 展开某检查项并返回其作用域定位器（幂等：已展开则不重复点击） */
async function openItem(page, code) {
  const card = page.locator(".item-card", { has: page.locator(".code", { hasText: code }) });
  if (!(await card.locator(".item-body").isVisible().catch(() => false))) {
    await card.locator(".item-head").click();
  }
  await card.locator(".item-body").waitFor();
  return card;
}

async function main() {
  // 启动被测服务（独立数据目录）
  const dataDir = mkdtempSync(path.join(tmpdir(), "hxwl-e2e-"));
  const server = spawn("node", ["server/index.js"], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try { await api("GET", "/api/health"); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }

  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    /* ============ 场景1：桌面全流程 + 检验角色只读 ============ */
    console.log("场景1：桌面端 登录→建单→录入→条件项→检验只读");
    const ctx1 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx1.newPage(); watch(page, "s1");
    await uiLogin(page, "wang", "wang123");
    ok("桌面端登录看板");

    await page.click("text=＋ 新建检查单");
    await page.fill("#ni-title", "E2E 桌面检查单");
    await page.fill("#ni-ac", "B-E2E1");
    await page.click(".modal >> text=创建");
    await page.waitForSelector(".item-card");
    ok("从已发布模板创建检查单");

    // 依赖门槛：EXT-02 依赖 EXT-01，未录 EXT-01 时按钮禁用
    const ext02 = await openItem(page, "EXT-02");
    assert.ok(await ext02.getByRole("button", { name: "通过", exact: true }).first().isDisabled(), "依赖未满足应禁用");
    ok("前置依赖未满足时录入被禁用");

    const ext01 = await openItem(page, "EXT-01");
    await ext01.getByRole("button", { name: "通过", exact: true }).click();
    await page.waitForSelector(".item-head .badge:text-is('通过')");
    ok("录入 EXT-01=通过");

    // EXT-02 不通过 → 触发条件项 EXT-03
    await ext02.getByRole("button", { name: "不通过", exact: true }).click();
    await page.waitForTimeout(400);
    const ext03 = await openItem(page, "EXT-03");
    assert.ok(await ext03.getByRole("button", { name: "通过", exact: true }).first().isEnabled(), "条件项应变为可录");
    ok("条件项 EXT-03 随 EXT-02=不通过 激活");

    // 检验角色：结果按钮禁用、无附件上传按钮
    await page.goto(BASE + "#/dash");
    await page.click("text=退出");
    await page.waitForSelector("#lg-user"); // 等退出完成，避免导航打断 logout 的死 token 竞态
    await uiLogin(page, "zhao", "zhao123");
    await page.click(".list-row >> nth=0");
    await page.waitForSelector(".item-card");
    const ext01z = await openItem(page, "EXT-01");
    assert.ok(await ext01z.getByRole("button", { name: "通过", exact: true }).first().isDisabled(), "检验角色结果按钮应禁用");
    assert.equal(await ext01z.locator("text=上传附件").count(), 0, "检验角色不应看到上传附件");
    const zhaoTok = await loginToken("zhao", "zhao123");
    const insList = (await api("GET", "/api/instances", { token: zhaoTok })).data.instances;
    const insId = insList[0].id;
    const insView = (await api("GET", `/api/instances/${insId}`, { token: zhaoTok })).data.instance;
    const forbidden = await api("PUT", `/api/instances/${insId}/results/EXT-01`, { token: zhaoTok, body: { status: "na", baseRevision: insView.revision } });
    assert.equal(forbidden.status, 403, "检验提交结果接口应 403");
    ok("检验角色页面禁用 + 接口 403 一致落实");
    await ctx1.close();

    /* ============ 场景2：离线编辑 + 断网刷新保留 + 联网同步 ============ */
    console.log("场景2：断网录入→断网刷新→联网同步");
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p2 = await ctx2.newPage(); watch(p2, "s2");
    await uiLogin(p2, "wang", "wang123");
    await p2.click(".list-row >> nth=0");
    await p2.waitForSelector(".item-card");
    await p2.waitForTimeout(600); // 等 Service Worker 安装
    await p2.reload();            // 让 SW 接管后续请求
    await p2.waitForSelector(".item-card");

    await p2.context().setOffline(true);
    await p2.waitForSelector("#net-status:has-text('离线')");
    const eng01 = await openItem(p2, "ENG-01");
    const passBtn = eng01.getByRole("button", { name: "通过", exact: true });
    assert.ok(await passBtn.isEnabled(), "离线时录入不应被禁用");
    await passBtn.click();
    await p2.waitForSelector(".toast:has-text('已离线保存')");
    await p2.waitForSelector("#net-status:has-text('待同步 1')");
    ok("断网后可录入，修改进入待同步队列");

    await p2.reload(); // 断网刷新：SW 提供页面，localStorage 恢复数据
    await p2.waitForSelector(".item-card");
    const eng01After = await openItem(p2, "ENG-01");
    await eng01After.locator(".item-head .badge", { hasText: "待同步" }).waitFor();
    ok("断网刷新后页面可加载，离线修改仍显示（通过·待同步）");

    await p2.context().setOffline(false);
    await p2.waitForSelector("#net-status:has-text('在线')", { timeout: 8000 });
    const wangTok = await loginToken("wang", "wang123");
    const synced = (await api("GET", `/api/instances/${insId}`, { token: wangTok })).data.instance;
    assert.equal(synced.results["ENG-01"].status, "pass", "联网后离线修改应同步到服务器");
    ok("联网自动同步，服务器已收到 ENG-01=通过");
    await ctx2.close();

    /* ============ 场景3：离线冲突——保留双方、明示选择、禁止静默覆盖 ============ */
    console.log("场景3：离线修改 × 他人在线修改同项 → 冲突裁决");
    const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p3 = await ctx3.newPage(); watch(p3, "s3");
    await uiLogin(p3, "wang", "wang123");
    await p3.click(".list-row >> nth=0");
    await p3.waitForSelector(".item-card");

    // 王工离线把 AVI-01 改为 不通过
    await p3.context().setOffline(true);
    const avi = await openItem(p3, "AVI-01");
    await avi.getByRole("button", { name: "不通过", exact: true }).click();
    await p3.waitForSelector(".toast:has-text('已离线保存')");

    // 李工在线把 AVI-01 改为 通过（模拟另一标签/另一人）
    const liTok = await loginToken("li", "li123");
    const cur1 = (await api("GET", `/api/instances/${insId}`, { token: liTok })).data.instance;
    const put = await api("PUT", `/api/instances/${insId}/results/AVI-01`, { token: liTok, body: { status: "pass", value: "", notes: "李工在线改", baseRevision: cur1.revision } });
    assert.equal(put.status, 200);

    // 王工联网 → 同步必须判冲突而不是覆盖
    await p3.context().setOffline(false);
    await p3.waitForSelector(".modal >> text=同步冲突", { timeout: 8000 });
    const modalText = await p3.textContent(".modal");
    assert.ok(modalText.includes("我的离线修改") && modalText.includes("不通过"), "冲突弹窗应展示我方内容");
    assert.ok(modalText.includes("对方（服务器）当前") && modalText.includes("通过"), "冲突弹窗应展示对方内容");
    const notOverwritten = (await api("GET", `/api/instances/${insId}`, { token: liTok })).data.instance;
    assert.equal(notOverwritten.results["AVI-01"].status, "pass", "未选择前服务器不得被静默覆盖");
    ok("冲突弹窗同时保留双方内容，选择前服务器未被覆盖");

    await p3.click(".modal >> text=采用我的修改");
    await p3.waitForSelector(".modal", { state: "detached", timeout: 8000 }).catch(() => {});
    const afterMine = (await api("GET", `/api/instances/${insId}`, { token: liTok })).data.instance;
    assert.equal(afterMine.results["AVI-01"].status, "fail", "明示选择后才应提交我的修改");
    ok("选择「采用我的」后服务器才更新为离线值");

    // 再来一次选「保留对方的」
    await p3.context().setOffline(true);
    const avi2 = await openItem(p3, "AVI-01");
    await avi2.getByRole("button", { name: "不适用", exact: true }).click();
    await p3.waitForSelector(".toast:has-text('已离线保存')");
    const cur2 = (await api("GET", `/api/instances/${insId}`, { token: liTok })).data.instance;
    await api("PUT", `/api/instances/${insId}/results/AVI-01`, { token: liTok, body: { status: "pass", value: "", notes: "李工再次改", baseRevision: cur2.revision } });
    await p3.context().setOffline(false);
    await p3.waitForSelector(".modal >> text=同步冲突", { timeout: 8000 });
    await p3.click(".modal >> text=保留对方的");
    await p3.waitForSelector(".modal", { state: "detached", timeout: 8000 }).catch(() => {});
    const afterTheirs = (await api("GET", `/api/instances/${insId}`, { token: liTok })).data.instance;
    assert.equal(afterTheirs.results["AVI-01"].status, "pass", "选择保留对方后服务器保持对方值");
    ok("选择「保留对方的」后服务器维持对方内容");
    await ctx3.close();

    /* ============ 场景4：手机视口完整流程（录入→双人签署→只读） ============ */
    console.log("场景4：手机视口全流程");
    const ctx4 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p4 = await ctx4.newPage(); watch(p4, "s4");
    await uiLogin(p4, "wang", "wang123");
    await p4.click("text=＋ 新建检查单");
    await p4.fill("#ni-title", "E2E 手机检查单");
    await p4.fill("#ni-ac", "B-MOB1");
    await p4.click(".modal >> text=创建");
    await p4.waitForSelector(".item-card");
    ok("手机端建单");

    const fill = async (code, label) => {
      const card = await openItem(p4, code);
      await card.getByRole("button", { name: label, exact: true }).tap();
      await p4.waitForTimeout(350);
    };
    await fill("EXT-01", "通过");
    await fill("EXT-02", "通过");   // EXT-02 通过 → 条件项 EXT-03 不适用
    await fill("ENG-01", "通过");
    await fill("ENG-02", "通过");
    await fill("AVI-01", "通过");
    await fill("FIN-01", "通过");
    ok("手机端逐项录入完成（含依赖顺序）");

    // 双人签署：弹窗内输入两位不同检验员口令
    const signAs = async (u, p) => {
      await p4.click("text=签署确认");
      await p4.fill("#sg-user", u);
      await p4.fill("#sg-pass", p);
      await p4.click(".modal >> text=确认签署");
      await p4.waitForTimeout(500);
    };
    await signAs("zhao", "zhao123");
    await p4.waitForSelector(".sign-slot.filled");
    await signAs("chen", "chen123");
    await p4.waitForSelector(".badge:has-text('已签署·只读')");
    ok("手机端双人签署完成，检查单锁定只读");

    const fin01 = await openItem(p4, "FIN-01");
    assert.ok(await fin01.getByRole("button", { name: "通过", exact: true }).first().isDisabled(), "签后录入应禁用");
    const mobileIns = (await api("GET", "/api/instances", { token: liTok })).data.instances.find((i) => i.title === "E2E 手机检查单");
    assert.equal(mobileIns.status, "signed");
    assert.equal(mobileIns.signatures.length, 2);
    assert.notEqual(mobileIns.signatures[0].userId, mobileIns.signatures[1].userId, "两名签署人必须不同");
    ok("签后只读 + 两名不同签署人（服务端核验）");
    await ctx4.close();

    console.log(`\n全部通过：${results.length} 项端到端验证`);
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((e) => { console.error("E2E 失败:", e); process.exit(1); });
