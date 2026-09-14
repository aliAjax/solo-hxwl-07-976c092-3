# 航空维修检查协作台（hxwl-inspection-workbench）

面向航空维修班组的检查单全流程协作系统：模板版本化发布、条件项与前置依赖、
缺陷处置-复检闭环、双人签署、撤销留痕、离线编辑、冲突裁决、整包导入导出。

## 技术栈

- 后端：Node.js + Express（零原生依赖），JSON 文件原子写持久化（`data/db.json`）
- 前端：原生 JS SPA（`public/`，无需构建）+ Service Worker 应用外壳缓存，响应式布局，手机/桌面均可走完全流程
- 测试：`node:test` 接口与回归测试；Playwright 真实浏览器端到端验证（桌面 + 手机视口）

## 启动

```bash
npm install     # 运行时仅 express 一个依赖
npm start       # 默认 http://localhost:5107（PORT 环境变量可改）
```

## 测试

```bash
npm test        # 15 组接口/回归测试：依赖循环/越权/并发签署/离线冲突/失败回滚等

# 端到端（真实 Chromium，桌面+手机视口，共 16 项验证）
npx playwright install chromium   # 首次需要；如缺系统库见下文「E2E 环境」
npm run e2e
```

## 演示账号

| 账号 | 密码 | 角色 | 权限 |
|---|---|---|---|
| admin | admin123 | 管理员 | 模板管理 + 录入 + 复检 + 签署 |
| wang / li | wang123 / li123 | 工程师 | 结果录入、附件、缺陷登记与处置 |
| zhao / chen | zhao123 / chen123 | 检验 | 缺陷复检、签署、撤销（结果/附件只读） |

权限在**接口与页面两层**一致落实：检验账号调用录入/附件接口返回 403，页面对应控件同步禁用/隐藏。
首次启动自动播种已发布的「A320 航前检查单」模板（含条件项与前置依赖）。

## 一条完整流程

1. **admin** → 检查模板 → 编辑草稿（检查项/前置依赖/条件项）→ 发布（发布后冻结，只能另起新版本）。
2. 任意用户 → 新建检查单（绑定某个已发布版本，之后模板再改不影响本单）。
3. **工程师** 逐项录入（依赖未满足的项锁定），可上传附件；发现问题 → 登记缺陷。
4. 缺陷由工程师**处置** → **另一人复检**（禁止自检自复）通过后才闭环。
5. 全部适用项完成、无未闭环缺陷 → **两名不同**检验/管理人员先后**签署** → 检查单锁定只读。
6. 如需修改 → 检验/管理员**撤销签署**（必填原因，原签名与原因永久留痕）。
7. 详情页**导出整包**（含附件与校验和）；看板页**导入整包**。

## 关键机制

- **模板冻结与绑定**：版本发布后内容哈希固定、拒绝修改；实例记录 `templateVersionId`，永远绑定创建时的版本。
- **依赖循环检测**：保存/发布草稿时对依赖图做 DFS，发现循环（含自依赖）即 422 并给出循环路径。
- **并发控制**：检查单有单调递增修订号，所有变更携带 `baseRevision`，不一致返回 409；
  并发签署同一修订号只有一方成功，绝不产生重复签名。
- **签署规则**：两名不同人员、签署角色 + 口令校验；未完成依赖/未闭环缺陷/未完成的适用条件项均阻止签署；签后一切修改返回 423。
- **离线编辑**：
  - Service Worker 缓存应用外壳，**断网刷新页面仍可加载**；
  - 已访问的检查单缓存在 localStorage，断网可继续录入（进入待同步队列并乐观显示「待同步」徽标）；
  - 刷新后离线修改仍在（缓存 + 队列合并渲染）；联网后自动同步。
- **冲突裁决（禁止静默覆盖）**：每条离线操作记录编辑时的服务器基线；同步时三方比对——
  服务器未动 → 自动提交；内容已一致 → 丢弃队列；**他人已改 → 保留双方内容，弹出裁决框，
  用户逐项明示「采用我的 / 保留对方的」后才生效**。检查单已签署时离线修改同样转裁决，绝不静默丢弃。
- **多标签协调**：变更经 BroadcastChannel 广播，另一标签页有未同步编辑时显示冲突横幅。
- **导入回滚**：导入包先校验格式与 sha256 校验和，全部通过在内存中构建完成后才一次性提交；
  损坏/篡改包直接 400，现有数据分毫不动（测试覆盖）。

## E2E 环境

`npm run e2e` 使用 Playwright + Chromium 验证桌面（1280×800）与手机（390×844 触屏）视口。
无 sudo 的环境可免 root 补齐 Chromium 系统库（Debian 系示例）：

```bash
mkdir -p /tmp/apt/lists/partial /tmp/apt/cache/archives/partial
apt-get -o Dir::State::Lists=/tmp/apt/lists -o Dir::Cache=/tmp/apt/cache -o Debug::NoLocking=1 update
cd /tmp/chromelibs && apt-get -o Dir::State::Lists=/tmp/apt/lists -o Dir::Cache=/tmp/apt/cache -o Debug::NoLocking=1 \
  download libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libdbus-1-3 libcups2 libxkbcommon0 \
  libasound2 libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
  libcairo2 libdrm2 libx11-6 libxcb1 libxext6 libxi6 libxtst6 libglib2.0-0 libexpat1 libffi8 \
  libx11-xcb1 libxcb-dri3-0 libxshmfence1 libxxf86vm1 libpangocairo-1.0-0 libavahi-common3 \
  libavahi-client3 libgnutls30 libp11-kit0 libtasn1-6 libhogweed6 libnettle8 libgmp10 \
  libwayland-server0 libwayland-client0 libwayland-cursor0 libwayland-egl1 libepoxy0
for f in *.deb; do dpkg -x "$f" /tmp/chromelibs/root; done
export LD_LIBRARY_PATH=/tmp/chromelibs/root/lib/aarch64-linux-gnu:/tmp/chromelibs/root/usr/lib/aarch64-linux-gnu
```

## API 概览

```
POST /api/auth/login|logout            GET /api/auth/me|users
GET|POST /api/templates                GET /api/templates/:id
PUT  /api/templates/:id/versions/:vid  POST .../publish   POST /api/templates/:id/versions
GET|POST /api/instances                GET /api/instances/:id
PUT  /api/instances/:id/results/:code        (engineer/admin)
POST|DELETE /api/instances/:id/...attachments (engineer/admin)
POST /api/instances/:id/defects        POST .../defects/:did/disposition (engineer/admin)
POST .../defects/:did/verify           (inspector/admin，且须非处置人)
POST /api/instances/:id/sign|revoke    GET /api/instances/:id/audit|export
POST /api/packages/import
```

数据文件：`data/db.json`（删除即重置为种子数据）。
