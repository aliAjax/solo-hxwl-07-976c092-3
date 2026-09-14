"use strict";
/**
 * 检查单实例：录入结果与附件、缺陷处置-复检闭环、双人签署、撤销留痕。
 * 并发控制：每次变更携带 baseRevision 乐观锁，不一致返回 409；
 * 签署后整单只读（423），撤销必须填写原因并完整留痕。
 */
const express = require("express");
const { db, save, audit } = require("./store");
const { id, now, verifyPassword } = require("./util");
const { requireAuth, requireRole, canSign } = require("./auth");

const router = express.Router();

/* ---------- 领域计算 ---------- */

function getTemplateVersion(instance) {
  return db.templateVersions.find((v) => v.id === instance.templateVersionId);
}

/** 条件项是否适用：无条件 → 适用；有条件 → 被引用项已有结果且命中取值 */
function isApplicable(item, instance) {
  if (!item.visibleWhen) return true;
  const ref = instance.results[item.visibleWhen.code];
  return !!(ref && item.visibleWhen.in.includes(ref.status));
}

function applicableItems(instance) {
  const tv = getTemplateVersion(instance);
  return tv.items.filter((it) => isApplicable(it, instance));
}

/** 某检查项未满足的前置依赖（仅统计当前适用的依赖项） */
function unmetDependencies(item, instance) {
  const tv = getTemplateVersion(instance);
  const byCode = new Map(tv.items.map((it) => [it.code, it]));
  return (item.deps || []).filter((depCode) => {
    const depItem = byCode.get(depCode);
    if (!depItem || !isApplicable(depItem, instance)) return false;
    const r = instance.results[depCode];
    return !r || !r.status;
  });
}

/** 签署前置检查：返回阻止签署的原因列表（空 = 可签署） */
function signBlockers(instance) {
  const blockers = [];
  const tv = getTemplateVersion(instance);
  const pending = applicableItems(instance).filter((it) => {
    const r = instance.results[it.code];
    return !r || !r.status;
  });
  if (pending.length) {
    blockers.push(`存在未完成的检查项：${pending.map((it) => it.code).join("、")}`);
  }
  for (const it of applicableItems(instance)) {
    const unmet = unmetDependencies(it, instance);
    if (unmet.length) blockers.push(`检查项 ${it.code} 的前置依赖未完成：${unmet.join("、")}`);
  }
  const openDefects = instance.defects.filter((d) => d.status !== "closed");
  if (openDefects.length) {
    blockers.push(`存在未闭环缺陷：${openDefects.map((d) => d.id.slice(-6)).join("、")}`);
  }
  return blockers;
}

function instanceView(instance) {
  const tv = getTemplateVersion(instance);
  const template = db.templates.find((t) => t.id === instance.templateId);
  const items = tv.items.map((it) => ({
    ...it,
    applicable: isApplicable(it, instance),
    unmetDependencies: unmetDependencies(it, instance),
    result: instance.results[it.code] || null,
    defects: instance.defects.filter((d) => d.itemCode === it.code),
  }));
  return {
    ...instance,
    templateName: template ? template.name : "(模板已删除)",
    versionNo: tv.versionNo,
    items,
    attachments: db.attachments
      .filter((a) => a.instanceId === instance.id)
      .map((a) => ({ id: a.id, itemCode: a.itemCode, name: a.name, mime: a.mime, size: a.size, uploadedBy: a.uploadedBy, uploadedAt: a.uploadedAt })),
    signBlockers: instance.status === "signed" ? [] : signBlockers(instance),
    progress: {
      applicable: applicableItems(instance).length,
      completed: applicableItems(instance).filter((it) => instance.results[it.code] && instance.results[it.code].status).length,
      openDefects: instance.defects.filter((d) => d.status !== "closed").length,
    },
  };
}

/* ---------- 守卫 ---------- */

function loadInstance(req, res) {
  const instance = db.instances.find((i) => i.id === req.params.id);
  if (!instance) {
    res.status(404).json({ error: "检查单不存在" });
    return null;
  }
  return instance;
}

/** 签署后只读：除撤销/导出外一律拒绝 */
function assertEditable(instance, res) {
  if (instance.status === "signed") {
    res.status(423).json({ error: "检查单已签署，处于只读状态；如需修改请先撤销签署" });
    return false;
  }
  return true;
}

/** 乐观锁：客户端必须基于最新修订号操作 */
function assertRevision(instance, req, res) {
  const baseRevision = req.body && req.body.baseRevision;
  if (typeof baseRevision !== "number" || baseRevision !== instance.revision) {
    res.status(409).json({
      error: "数据已被他人修改（修订号不一致），请刷新后重试",
      currentRevision: instance.revision,
    });
    return false;
  }
  return true;
}

function touch(instance, req, action, detail) {
  instance.revision += 1;
  instance.updatedAt = now();
  audit(req.user, action, "instance", instance.id, detail || {});
}

/* ---------- 路由 ---------- */

router.get("/", requireAuth, (req, res) => {
  const list = db.instances
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((i) => {
      const view = instanceView(i);
      return {
        id: view.id,
        title: view.title,
        aircraft: view.aircraft,
        status: view.status,
        revision: view.revision,
        templateName: view.templateName,
        versionNo: view.versionNo,
        progress: view.progress,
        signatures: view.signatures,
        createdBy: view.createdBy,
        createdAt: view.createdAt,
      };
    });
  res.json({ instances: list });
});

/** 从已发布模板版本创建检查单（实例绑定该版本，之后模板再改也不影响） */
router.post("/", requireAuth, (req, res) => {
  const { templateVersionId, title, aircraft } = req.body || {};
  const version = db.templateVersions.find((v) => v.id === templateVersionId);
  if (!version) return res.status(404).json({ error: "模板版本不存在" });
  if (version.status !== "published") return res.status(422).json({ error: "只能从已发布的模板版本创建检查单" });
  const instance = {
    id: id("ins"),
    templateId: version.templateId,
    templateVersionId: version.id,
    title: (title && String(title).trim()) || `${version.templateId} 检查单`,
    aircraft: aircraft || "",
    status: "in_progress",
    revision: 1,
    results: {},
    defects: [],
    signatures: [],
    revocations: [],
    createdBy: req.user.displayName,
    createdAt: now(),
    updatedAt: now(),
  };
  db.instances.push(instance);
  audit(req.user, "instance.create", "instance", instance.id, { templateVersionId: version.id });
  save();
  res.status(201).json({ instance: instanceView(instance) });
});

router.get("/:id", requireAuth, (req, res) => {
  const instance = loadInstance(req, res);
  if (!instance) return;
  res.json({ instance: instanceView(instance) });
});

/** 录入/修改某检查项结果（仅工程师/管理员；检验角色只读，复检走缺陷流程） */
router.put("/:id/results/:itemCode", requireAuth, requireRole("engineer", "admin"), (req, res) => {
  const instance = loadInstance(req, res);
  if (!instance) return;
  if (!assertEditable(instance, res)) return;
  if (!assertRevision(instance, req, res)) return;
  const tv = getTemplateVersion(instance);
  const item = tv.items.find((it) => it.code === req.params.itemCode);
  if (!item) return res.status(404).json({ error: "检查项不存在" });
  const { status, value, notes } = req.body || {};
  if (!["pass", "fail", "na"].includes(status)) {
    return res.status(422).json({ error: "结果状态必须是 pass/fail/na" });
  }
  const unmet = unmetDependencies(item, instance);
  if (unmet.length) {
    return res.status(422).json({ error: `前置依赖未完成，不能录入：${unmet.join("、")}`, unmetDependencies: unmet });
  }
  instance.results[item.code] = {
    status,
    value: value || "",
    notes: notes || "",
    updatedBy: req.user.displayName,
    updatedAt: now(),
  };
  touch(instance, req, "instance.result", { itemCode: item.code, status });
  save();
  res.json({ instance: instanceView(instance) });
});

/** 上传附件（base64，绑定检查项；仅工程师/管理员） */
router.post("/:id/results/:itemCode/attachments", requireAuth, requireRole("engineer", "admin"), (req, res) => {
  const instance = loadInstance(req, res);
  if (!instance) return;
  if (!assertEditable(instance, res)) return;
  if (!assertRevision(instance, req, res)) return;
  const { name, mime, data } = req.body || {};
  if (!name || !data) return res.status(400).json({ error: "附件缺少文件名或内容" });
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > 10 * 1024 * 1024) return res.status(413).json({ error: "单个附件不能超过 10MB" });
  const attachment = {
    id: id("att"),
    instanceId: instance.id,
    itemCode: req.params.itemCode,
    name: String(name),
    mime: mime || "application/octet-stream",
    size: bytes.length,
    data: data,
    uploadedBy: req.user.displayName,
    uploadedAt: now(),
  };
  db.attachments.push(attachment);
  touch(instance, req, "instance.attachment.add", { itemCode: req.params.itemCode, name: attachment.name, size: attachment.size });
  save();
  res.status(201).json({ instance: instanceView(instance) });
});

router.get("/:id/attachments/:attachmentId", requireAuth, (req, res) => {
  const attachment = db.attachments.find((a) => a.id === req.params.attachmentId && a.instanceId === req.params.id);
  if (!attachment) return res.status(404).json({ error: "附件不存在" });
  res.json({ attachment });
});

/** 删除附件（仅工程师/管理员） */
router.delete("/:id/attachments/:attachmentId", requireAuth, requireRole("engineer", "admin"), (req, res) => {
  const instance = loadInstance(req, res);
  if (!instance) return;
  if (!assertEditable(instance, res)) return;
  if (!assertRevision(instance, req, res)) return;
  const before = db.attachments.length;
  db.attachments = db.attachments.filter((a) => !(a.id === req.params.attachmentId && a.instanceId === instance.id));
  if (db.attachments.length === before) return res.status(404).json({ error: "附件不存在" });
  touch(instance, req, "instance.attachment.remove", { attachmentId: req.params.attachmentId });
  save();
  res.json({ instance: instanceView(instance) });
});

/* ---------- 缺陷闭环：开单 → 处置 → 另一人复检 ---------- */

router.post("/:id/defects", requireAuth, (req, res) => {
  const instance = loadInstance(req, res);
  if (!instance) return;
  if (!assertEditable(instance, res)) return;
  if (!assertRevision(instance, req, res)) return;
  const { itemCode, description } = req.body || {};
  if (!description || !String(description).trim()) return res.status(400).json({ error: "缺陷描述不能为空" });
  const defect = {
    id: id("def"),
    itemCode: itemCode || null,
    description: String(description).trim(),
    status: "open",
    createdBy: req.user.displayName,
    createdAt: now(),
    disposition: null,
    verification: null,
    history: [{ at: now(), by: req.user.displayName, action: "open", note: String(description).trim() }],
  };
  instance.defects.push(defect);
  touch(instance, req, "instance.defect.open", { defectId: defect.id, itemCode: defect.itemCode });
  save();
  res.status(201).json({ instance: instanceView(instance) });
});

/** 处置（工程师/管理员） */
router.post("/:id/defects/:defectId/disposition", requireAuth, requireRole("engineer", "admin"), (req, res) => {
  const instance = loadInstance(req, res);
  if (!instance) return;
  if (!assertEditable(instance, res)) return;
  if (!assertRevision(instance, req, res)) return;
  const defect = instance.defects.find((d) => d.id === req.params.defectId);
  if (!defect) return res.status(404).json({ error: "缺陷不存在" });
  if (defect.status === "closed") return res.status(422).json({ error: "缺陷已闭环，不能再处置" });
  const { text } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: "处置措施不能为空" });
  defect.status = "disposed";
  defect.disposition = { text: String(text).trim(), by: req.user.displayName, byId: req.user.id, at: now() };
  defect.history.push({ at: now(), by: req.user.displayName, action: "dispose", note: defect.disposition.text });
  touch(instance, req, "instance.defect.dispose", { defectId: defect.id });
  save();
  res.json({ instance: instanceView(instance) });
});

/** 复检：必须由不同于处置人的人员执行 */
router.post("/:id/defects/:defectId/verify", requireAuth, requireRole("inspector", "admin"), (req, res) => {
  const instance = loadInstance(req, res);
  if (!instance) return;
  if (!assertEditable(instance, res)) return;
  if (!assertRevision(instance, req, res)) return;
  const defect = instance.defects.find((d) => d.id === req.params.defectId);
  if (!defect) return res.status(404).json({ error: "缺陷不存在" });
  if (defect.status !== "disposed") return res.status(422).json({ error: "缺陷尚未处置，不能复检" });
  if (defect.disposition && defect.disposition.byId === req.user.id) {
    return res.status(422).json({ error: "复检人必须与处置人不同（禁止自检自复）" });
  }
  const { result, notes } = req.body || {};
  if (!["pass", "reject"].includes(result)) return res.status(422).json({ error: "复检结论必须是 pass/reject" });
  defect.verification = { result, notes: notes || "", by: req.user.displayName, byId: req.user.id, at: now() };
  defect.status = result === "pass" ? "closed" : "open";
  defect.history.push({ at: now(), by: req.user.displayName, action: `verify-${result}`, note: notes || "" });
  touch(instance, req, "instance.defect.verify", { defectId: defect.id, result });
  save();
  res.json({ instance: instanceView(instance) });
});

/* ---------- 签署与撤销 ---------- */

/**
 * 签署：需两名不同人员先后确认。
 * 请求体携带签署人账号口令（支持同工位两人先后确认），
 * 服务端校验签署资格、前置条件与乐观锁；并发时只有一方成功。
 */
router.post("/:id/sign", requireAuth, (req, res) => {
  const instance = loadInstance(req, res);
  if (!instance) return;
  if (instance.status === "signed") return res.status(423).json({ error: "检查单已完成双人签署，不可重复签署" });
  if (!assertRevision(instance, req, res)) return;
  const { username, password } = req.body || {};
  const signer = db.users.find((u) => u.username === username);
  if (!signer || !verifyPassword(password, signer.passwordHash)) {
    return res.status(401).json({ error: "签署人账号或口令错误" });
  }
  if (!canSign(signer)) {
    return res.status(403).json({ error: `用户 ${signer.displayName} 不具备签署资格（需要检验/管理角色）` });
  }
  if (instance.signatures.some((s) => s.userId === signer.id)) {
    return res.status(422).json({ error: "同一人不能重复签署；需两名不同人员确认" });
  }
  const blockers = signBlockers(instance);
  if (blockers.length) return res.status(422).json({ error: "存在阻止签署的问题", blockers });
  instance.signatures.push({ userId: signer.id, userName: signer.displayName, at: now() });
  if (instance.signatures.length >= 2) {
    instance.status = "signed";
    instance.signedAt = now();
  }
  touch(instance, req, "instance.sign", { signer: signer.displayName, count: instance.signatures.length, status: instance.status });
  save();
  res.json({ instance: instanceView(instance) });
});

/** 撤销签署：必须填写原因，历史签名与撤销记录全部留痕 */
router.post("/:id/revoke", requireAuth, requireRole("inspector", "admin"), (req, res) => {
  const instance = loadInstance(req, res);
  if (!instance) return;
  if (!assertRevision(instance, req, res)) return;
  if (instance.status !== "signed") return res.status(422).json({ error: "检查单尚未签署，无需撤销" });
  const { reason } = req.body || {};
  if (!reason || !String(reason).trim()) return res.status(422).json({ error: "撤销必须填写原因" });
  instance.revocations.push({
    at: now(),
    by: req.user.displayName,
    reason: String(reason).trim(),
    revokedSignatures: instance.signatures.slice(),
  });
  instance.signatures = [];
  instance.status = "in_progress";
  instance.signedAt = null;
  touch(instance, req, "instance.revoke", { reason: String(reason).trim() });
  save();
  res.json({ instance: instanceView(instance) });
});

/** 该检查单的完整审计轨迹 */
router.get("/:id/audit", requireAuth, (req, res) => {
  const instance = loadInstance(req, res);
  if (!instance) return;
  const entries = db.audits.filter((a) => a.entityType === "instance" && a.entityId === instance.id);
  res.json({ audits: entries });
});

module.exports = { router, signBlockers, isApplicable, unmetDependencies };
