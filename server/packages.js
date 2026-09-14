"use strict";
/**
 * 整包导入导出：
 * - 导出：检查单 + 绑定的模板版本快照 + 全部附件 + 审计轨迹，附 sha256 校验和。
 * - 导入：先完整校验（格式/校验和/结构/模板版本一致性），全部通过后才一次性提交；
 *   任何一步失败都不触碰现有数据（天然回滚），损坏包导入后原数据保持不变。
 */
const express = require("express");
const { db, save, audit } = require("./store");
const { id, now, canonical, contentHash, clone } = require("./util");
const { requireAuth } = require("./auth");

const router = express.Router();
const FORMAT = "aipkg@1";

/** 组装导出包 */
function buildPackage(instance) {
  const templateVersion = db.templateVersions.find((v) => v.id === instance.templateVersionId);
  const template = db.templates.find((t) => t.id === instance.templateId);
  const attachments = db.attachments.filter((a) => a.instanceId === instance.id);
  const audits = db.audits.filter((a) => a.entityType === "instance" && a.entityId === instance.id);
  const payload = {
    template: template || null,
    templateVersion,
    instance,
    attachments,
    audits,
  };
  return {
    format: FORMAT,
    exportedAt: now(),
    checksum: contentHash(payload),
    payload,
  };
}

router.get("/instances/:id/export", requireAuth, (req, res) => {
  const instance = db.instances.find((i) => i.id === req.params.id);
  if (!instance) return res.status(404).json({ error: "检查单不存在" });
  const pkg = buildPackage(instance);
  audit(req.user, "instance.export", "instance", instance.id, {});
  save();
  res.json(pkg);
});

/** 校验导入包，返回错误消息数组（空 = 通过）。不做任何写操作。 */
function validatePackage(pkg) {
  const errors = [];
  if (!pkg || typeof pkg !== "object") return ["包不是有效的 JSON 对象"];
  if (pkg.format !== FORMAT) errors.push(`包格式不支持：${pkg.format || "(缺失)"}，需要 ${FORMAT}`);
  if (!pkg.payload || typeof pkg.payload !== "object") errors.push("包缺少 payload");
  if (errors.length) return errors;
  if (typeof pkg.checksum !== "string" || pkg.checksum !== contentHash(pkg.payload)) {
    errors.push("校验和不匹配：包已损坏或被篡改");
    return errors; // 内容不可信，不再深入校验
  }
  const { template, templateVersion, instance, attachments, audits } = pkg.payload;
  if (!templateVersion || !templateVersion.id || !Array.isArray(templateVersion.items)) {
    errors.push("包内模板版本数据缺失或损坏");
  }
  if (!instance || !instance.id || !instance.templateVersionId) {
    errors.push("包内检查单数据缺失或损坏");
  } else if (templateVersion && instance.templateVersionId !== templateVersion.id) {
    errors.push("检查单与模板版本不匹配");
  }
  if (instance && typeof instance.revision !== "number") errors.push("检查单缺少修订号");
  if (attachments !== undefined && !Array.isArray(attachments)) errors.push("附件列表损坏");
  if (audits !== undefined && !Array.isArray(audits)) errors.push("审计记录损坏");
  for (const a of attachments || []) {
    if (!a.id || !a.name || typeof a.data !== "string") {
      errors.push(`附件记录损坏：${(a && a.name) || "(未知)"}`);
      break;
    }
  }
  if (template && templateVersion && template.id !== templateVersion.templateId) {
    errors.push("模板与模板版本归属不一致");
  }
  return errors;
}

/**
 * 导入整包。两阶段：
 *   1. 纯校验（不碰 db）；
 *   2. 在内存副本上构建全部新对象，确认无冲突后一次性 push + save。
 * 任一阶段失败 → 返回错误，现有数据分毫不动。
 */
router.post("/packages/import", requireAuth, (req, res) => {
  const pkg = req.body;
  const errors = validatePackage(pkg);
  if (errors.length) {
    return res.status(400).json({ error: "导入包校验失败，已放弃导入，现有数据未受影响", details: errors });
  }
  const { template, templateVersion, instance, attachments = [], audits: pkgAudits = [] } = pkg.payload;

  // 模板版本一致性：本地已有同 ID 版本时，内容必须完全一致（防止同名不同内容覆盖）
  const existingVersion = db.templateVersions.find((v) => v.id === templateVersion.id);
  if (existingVersion && contentHash(existingVersion) !== contentHash(templateVersion)) {
    return res.status(409).json({ error: "模板版本与本地同 ID 版本内容不一致，导入被拒绝" });
  }

  // 以下在局部变量中构建，全部成功后才写入 db（提交点）
  const newInstanceId = id("ins");
  const attachmentIdMap = new Map();
  const newAttachments = attachments.map((a) => {
    const newId = id("att");
    attachmentIdMap.set(a.id, newId);
    return { ...clone(a), id: newId, instanceId: newInstanceId };
  });
  const newInstance = {
    ...clone(instance),
    id: newInstanceId,
    importedAt: now(),
    importedBy: req.user.displayName,
    importedFrom: instance.id,
  };
  const newAudits = pkgAudits.map((a) => ({ ...clone(a), entityId: newInstanceId }));
  newAudits.push({
    id: id("aud"),
    at: now(),
    actorId: req.user.id,
    actorName: req.user.displayName,
    action: "instance.import",
    entityType: "instance",
    entityId: newInstanceId,
    detail: { from: instance.id, title: instance.title },
  });

  // ---- 提交点：前面的校验全部通过，这里才开始改库 ----
  if (!existingVersion) {
    if (template && !db.templates.find((t) => t.id === template.id)) {
      db.templates.push(clone(template));
    }
    db.templateVersions.push({ ...clone(templateVersion), status: "published" }); // 导入的版本一律视为已发布冻结
  }
  db.instances.push(newInstance);
  db.attachments.push(...newAttachments);
  db.audits.push(...newAudits);
  save();
  res.status(201).json({ ok: true, instanceId: newInstanceId, title: newInstance.title });
});

module.exports = { router, validatePackage, buildPackage, FORMAT };
