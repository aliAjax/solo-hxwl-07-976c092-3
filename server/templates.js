"use strict";
/**
 * 检查模板：草稿编辑 → 发布冻结 → 新版本再编辑。
 * - 检查项支持条件项（visibleWhen：依赖某项结果）与前置依赖（deps）。
 * - 保存/发布时做引用校验与依赖循环检测，存在循环即拒绝。
 * - 发布后版本冻结不可修改；检查单实例绑定具体已发布版本。
 */
const express = require("express");
const { db, save, audit } = require("./store");
const { id, now, contentHash } = require("./util");
const { requireAuth, requireRole } = require("./auth");

const router = express.Router();
const RESULT_STATUSES = ["pass", "fail", "na"];

/** 在依赖图上做循环检测，返回循环路径（数组）或 null */
function findCycle(items) {
  const depsOf = new Map(items.map((it) => [it.code, it.deps || []]));
  const state = new Map(); // 0=未访问 1=访问中 2=完成
  const stack = [];
  function visit(code) {
    state.set(code, 1);
    stack.push(code);
    for (const dep of depsOf.get(code) || []) {
      if (!depsOf.has(dep)) continue; // 悬空引用由 validateItems 单独报
      if (state.get(dep) === 1) {
        return stack.slice(stack.indexOf(dep)).concat(dep);
      }
      if (!state.get(dep)) {
        const cycle = visit(dep);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(code, 2);
    return null;
  }
  for (const it of items) {
    if (!state.get(it.code)) {
      const cycle = visit(it.code);
      if (cycle) return cycle;
    }
  }
  return null;
}

/** 校验检查项集合，返回错误消息数组（空数组 = 通过） */
function validateItems(items) {
  const errors = [];
  if (!Array.isArray(items) || items.length === 0) {
    return ["检查项列表不能为空"];
  }
  const codes = new Set();
  for (const it of items) {
    if (!it.code || typeof it.code !== "string" || !it.code.trim()) {
      errors.push("存在缺少编码(code)的检查项");
      continue;
    }
    it.code = it.code.trim();
    if (codes.has(it.code)) errors.push(`检查项编码重复：${it.code}`);
    codes.add(it.code);
    if (!it.title || !String(it.title).trim()) errors.push(`检查项 ${it.code} 缺少标题`);
    it.deps = Array.isArray(it.deps) ? it.deps.map(String) : [];
  }
  for (const it of items) {
    for (const dep of it.deps) {
      if (!codes.has(dep)) errors.push(`检查项 ${it.code} 的前置依赖 ${dep} 不存在`);
      if (dep === it.code) errors.push(`检查项 ${it.code} 不能依赖自身`);
    }
    if (it.visibleWhen) {
      const vw = it.visibleWhen;
      if (!codes.has(vw.code)) {
        errors.push(`检查项 ${it.code} 的条件引用 ${vw.code} 不存在`);
      } else if (vw.code === it.code) {
        errors.push(`检查项 ${it.code} 的条件不能引用自身`);
      }
      if (!Array.isArray(vw.in) || vw.in.length === 0 || vw.in.some((s) => !RESULT_STATUSES.includes(s))) {
        errors.push(`检查项 ${it.code} 的条件取值必须是 pass/fail/na 之一`);
      }
    }
  }
  if (errors.length === 0) {
    const cycle = findCycle(items);
    if (cycle) errors.push(`前置依赖存在循环：${cycle.join(" → ")}`);
  }
  return errors;
}

function versionView(v) {
  return {
    id: v.id,
    templateId: v.templateId,
    versionNo: v.versionNo,
    status: v.status,
    items: v.items,
    itemCount: v.items.length,
    hash: contentHash(v.items),
    createdAt: v.createdAt,
    publishedAt: v.publishedAt || null,
    publishedBy: v.publishedBy || null,
  };
}

router.get("/", requireAuth, (req, res) => {
  const templates = db.templates.map((t) => ({
    ...t,
    versions: db.templateVersions
      .filter((v) => v.templateId === t.id)
      .sort((a, b) => b.versionNo - a.versionNo)
      .map(versionView),
  }));
  res.json({ templates });
});

router.post("/", requireAuth, requireRole("admin"), (req, res) => {
  const { name, ataChapter, description } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "模板名称不能为空" });
  const template = {
    id: id("tpl"),
    name: String(name).trim(),
    ataChapter: ataChapter || "",
    description: description || "",
    createdAt: now(),
  };
  const draft = {
    id: id("tv"),
    templateId: template.id,
    versionNo: 1,
    status: "draft",
    items: [],
    createdAt: now(),
  };
  db.templates.push(template);
  db.templateVersions.push(draft);
  audit(req.user, "template.create", "template", template.id, { name: template.name });
  save();
  res.status(201).json({ template: { ...template, versions: [versionView(draft)] } });
});

router.get("/:templateId", requireAuth, (req, res) => {
  const template = db.templates.find((t) => t.id === req.params.templateId);
  if (!template) return res.status(404).json({ error: "模板不存在" });
  const versions = db.templateVersions
    .filter((v) => v.templateId === template.id)
    .sort((a, b) => b.versionNo - a.versionNo)
    .map(versionView);
  res.json({ template: { ...template, versions } });
});

/** 保存草稿内容（仅草稿可改；已发布版本冻结） */
router.put("/:templateId/versions/:versionId", requireAuth, requireRole("admin"), (req, res) => {
  const version = db.templateVersions.find(
    (v) => v.id === req.params.versionId && v.templateId === req.params.templateId
  );
  if (!version) return res.status(404).json({ error: "模板版本不存在" });
  if (version.status !== "draft") {
    return res.status(423).json({ error: "版本已发布并冻结，请创建新版本后再修改" });
  }
  const items = (req.body && req.body.items) || [];
  const errors = validateItems(items);
  if (errors.length) return res.status(422).json({ error: "检查项校验失败", details: errors });
  version.items = items.map((it) => ({
    code: it.code,
    title: String(it.title).trim(),
    description: it.description || "",
    category: it.category || "通用",
    deps: it.deps,
    visibleWhen: it.visibleWhen || null,
  }));
  version.updatedAt = now();
  audit(req.user, "template.draft.save", "templateVersion", version.id, { items: version.items.length });
  save();
  res.json({ version: versionView(version) });
});

/** 发布：冻结当前草稿 */
router.post("/:templateId/versions/:versionId/publish", requireAuth, requireRole("admin"), (req, res) => {
  const version = db.templateVersions.find(
    (v) => v.id === req.params.versionId && v.templateId === req.params.templateId
  );
  if (!version) return res.status(404).json({ error: "模板版本不存在" });
  if (version.status !== "draft") return res.status(423).json({ error: "该版本已发布，不能重复发布" });
  const errors = validateItems(version.items);
  if (errors.length) return res.status(422).json({ error: "检查项校验失败，不能发布", details: errors });
  version.status = "published";
  version.publishedAt = now();
  version.publishedBy = req.user.displayName;
  audit(req.user, "template.publish", "templateVersion", version.id, {
    templateId: version.templateId,
    versionNo: version.versionNo,
    hash: contentHash(version.items),
  });
  save();
  res.json({ version: versionView(version) });
});

/** 基于最新版本创建新草稿（发布后如需修改只能走这里） */
router.post("/:templateId/versions", requireAuth, requireRole("admin"), (req, res) => {
  const template = db.templates.find((t) => t.id === req.params.templateId);
  if (!template) return res.status(404).json({ error: "模板不存在" });
  const existing = db.templateVersions.filter((v) => v.templateId === template.id);
  if (existing.some((v) => v.status === "draft")) {
    return res.status(409).json({ error: "已存在未发布的草稿版本，请先发布或修改该草稿" });
  }
  const latest = existing.sort((a, b) => b.versionNo - a.versionNo)[0];
  const draft = {
    id: id("tv"),
    templateId: template.id,
    versionNo: (latest ? latest.versionNo : 0) + 1,
    status: "draft",
    items: latest ? JSON.parse(JSON.stringify(latest.items)) : [],
    createdAt: now(),
  };
  db.templateVersions.push(draft);
  audit(req.user, "template.version.create", "templateVersion", draft.id, { versionNo: draft.versionNo });
  save();
  res.status(201).json({ version: versionView(draft) });
});

module.exports = { router, validateItems, findCycle, RESULT_STATUSES };
