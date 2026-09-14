"use strict";
const crypto = require("crypto");

/** 生成带前缀的随机 ID */
function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

/** 当前时间 ISO 字符串 */
function now() {
  return new Date().toISOString();
}

/** sha256 十六进制摘要 */
function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * 确定性 JSON 序列化（键排序），用于内容哈希与包校验和。
 * 同一对象无论键顺序如何都得到相同字符串。
 */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",");
  return `{${body}}`;
}

/** 内容指纹：用于模板版本一致性比对、导出包校验 */
function contentHash(value) {
  return sha256(canonical(value));
}

/** scrypt 口令散列，格式 salt:hash（hex） */
function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), useSalt, 64).toString("hex");
  return `${useSalt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/** 深拷贝（仅 JSON 安全数据） */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { id, now, sha256, canonical, contentHash, hashPassword, verifyPassword, clone };
