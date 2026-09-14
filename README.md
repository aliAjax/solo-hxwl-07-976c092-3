# 航空维修检查协作台（hxwl-inspection-workbench）

面向航空维修班组的检查单全流程协作系统：模板版本化发布、条件项与前置依赖、
缺陷处置-复检闭环、双人签署、撤销留痕、离线编辑、多标签冲突提示、整包导入导出。

## 技术栈

- 后端：Node.js + Express（零原生依赖），JSON 文件原子写持久化（`data/db.json`）
- 前端：原生 JS SPA（`public/`，无需构建），响应式布局，手机/桌面均可走完全流程
- 测试：Node 内置 `node:test`

## 启动

```bash
npm install     # 仅 express 一个依赖
npm start       # 默认 http://localhost:5107（PORT 环境变量可改）
```

运行测试：

```bash
npm test        # 9 组端到端测试：依赖循环/越权/并发签署/失败回滚等
```

## 演示账号

| 账号 | 密码 | 角色 | 能做什么 |
|---|---|---|---|
| admin | admin123 | 管理员 | 模板创建/发布/签署/复检/撤销 |
| wang / li | wang123 / li123 | 工程师 | 录入结果、上传附件、登记与处置缺陷 |
| zhao / chen | zhao123 / chen123 | 检验 | 缺陷复检、签署、撤销 |

首次启动自动播种一个已发布的「A320 航前检查单」模板（含条件项与前置依赖），可直接新建检查单体验。

## 一条完整流程

1. **admin** 登录 → 检查模板 → 编辑草稿（检查项、前置依赖、条件项）→ 保存 → **发布**（发布后冻结，只能另起新版本）。
2. 任意用户 → 检查单 → 新建检查单（绑定某个**已发布版本**，之后模板再改不影响本单）。
3. **工程师** 逐项录入（前置依赖未完成时该项锁定不可录），可上传附件；发现问题 → 登记缺陷。
4. 缺陷由工程师**处置** → 必须由**另一人复检**（禁止自检自复）通过后才闭环。
5. 全部适用项完成、无未闭环缺陷后 → **两名不同**的检验/管理人员先后**签署** → 检查单锁定只读。
6. 如需修改 → 检验/管理员**撤销签署**（必填原因，原签名与原因永久留痕于审计轨迹）。
7. 检查单详情页可**导出整包**（含附件与校验和）；看板页可**导入整包**。

## 关键机制说明

- **模板冻结与绑定**：版本发布后内容哈希固定、拒绝修改；实例记录 `templateVersionId`，永远绑定创建时的版本。
- **依赖循环检测**：保存/发布草稿时对依赖图做 DFS，发现循环（含自依赖）即 422 并给出循环路径。
- **并发控制**：每个检查单有单调递增修订号，所有变更须携带 `baseRevision`，不一致返回 409；
  并发签署同一修订号时只有一方成功，绝不会产生重复签名。
- **签署规则**：两名不同人员、须具备签署角色、口令校验；未完成依赖/未闭环缺陷/未完成的适用条件项都会阻止签署；签后一切修改返回 423。
- **离线编辑**：结果录入在离线时写入 localStorage 队列并乐观更新，恢复网络后自动同步；
  草稿随刷新保留；同步遇冲突时提示并保留服务端数据。
- **多标签协调**：变更通过 BroadcastChannel 广播，另一标签页有未同步编辑时显示冲突横幅，禁止静默覆盖。
- **导入回滚**：导入包先校验格式与 sha256 校验和，全部通过在内存中构建完成后才一次性提交；
  损坏/篡改包直接 400，现有数据分毫不动（测试覆盖）。

## API 概览

```
POST /api/auth/login|logout            GET /api/auth/me|users
GET|POST /api/templates                GET /api/templates/:id
PUT  /api/templates/:id/versions/:vid  POST .../publish   POST /api/templates/:id/versions
GET|POST /api/instances                GET /api/instances/:id
PUT  /api/instances/:id/results/:code  POST|DELETE /api/instances/:id/...attachments
POST /api/instances/:id/defects        POST .../defects/:did/disposition|verify
POST /api/instances/:id/sign|revoke    GET /api/instances/:id/audit|export
POST /api/packages/import
```

数据文件：`data/db.json`（删除即重置为种子数据）。
