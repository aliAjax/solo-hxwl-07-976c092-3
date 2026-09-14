"use strict";
/**
 * 持久化层：内存模型 + 原子写 JSON 文件。
 * 每次变更先写临时文件再 rename，崩溃不会留下半截文件；
 * 导入等批量操作在内存中完成校验后才提交，失败即整体放弃（回滚）。
 */
const fs = require("fs");
const path = require("path");
const { id, now, hashPassword } = require("./util");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

const db = {
  users: [],
  tokens: [],
  templates: [],
  templateVersions: [],
  instances: [],
  attachments: [],
  audits: [],
};

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE); // 原子替换
}

function load() {
  if (fs.existsSync(DB_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    for (const key of Object.keys(db)) {
      if (Array.isArray(parsed[key])) db[key] = parsed[key];
    }
    return;
  }
  seed();
  save();
}

/** 追加审计条目（仅追加，不修改历史） */
function audit(actor, action, entityType, entityId, detail) {
  db.audits.push({
    id: id("aud"),
    at: now(),
    actorId: actor ? actor.id : null,
    actorName: actor ? actor.displayName : "系统",
    action,
    entityType,
    entityId,
    detail: detail || {},
  });
}

function seed() {
  const mk = (username, password, displayName, roles) => ({
    id: id("usr"),
    username,
    displayName,
    roles,
    passwordHash: hashPassword(password),
    createdAt: now(),
  });
  db.users.push(
    mk("admin", "admin123", "系统管理员", ["admin"]),
    mk("wang", "wang123", "王工", ["engineer"]),
    mk("li", "li123", "李工", ["engineer"]),
    mk("zhao", "zhao123", "赵检", ["inspector"]),
    mk("chen", "chen123", "陈检", ["inspector"])
  );

  // 示例模板：A320 航前检查（含条件项与前置依赖），直接以已发布 v1 提供
  const templateId = "tpl_demo_a320";
  const items = [
    { code: "EXT-01", title: "机体外观检查", category: "机体", description: "蒙皮、天线、静压孔无损伤", deps: [], visibleWhen: null },
    { code: "EXT-02", title: "起落架与轮胎检查", category: "起落架", description: "主轮磨耗、减震支柱镜面", deps: ["EXT-01"], visibleWhen: null },
    { code: "EXT-03", title: "轮胎更换记录", category: "起落架", description: "磨耗超标时填写更换件号", deps: ["EXT-02"], visibleWhen: { code: "EXT-02", in: ["fail"] } },
    { code: "ENG-01", title: "发动机滑油量检查", category: "动力装置", description: "滑油量在绿区", deps: [], visibleWhen: null },
    { code: "ENG-02", title: "发动机试车", category: "动力装置", description: "慢车参数稳定", deps: ["ENG-01"], visibleWhen: null },
    { code: "AVI-01", title: "航电系统自检", category: "航电", description: "BITE 无故障信息", deps: [], visibleWhen: null },
    { code: "FIN-01", title: "放行前最终确认", category: "放行", description: "所有检查项完成后确认", deps: ["EXT-02", "ENG-02", "AVI-01"], visibleWhen: null },
  ];
  db.templates.push({
    id: templateId,
    name: "A320 航前检查单",
    ataChapter: "ATA 05/12/32",
    description: "航前例行检查，按 ATA 章节分组",
    createdAt: now(),
  });
  db.templateVersions.push({
    id: "tv_demo_a320_v1",
    templateId,
    versionNo: 1,
    status: "published",
    items,
    createdAt: now(),
    publishedAt: now(),
    publishedBy: "系统",
  });
  audit(null, "seed", "system", "bootstrap", { users: db.users.length });
}

module.exports = { db, save, load, audit, DATA_DIR };
