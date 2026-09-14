"use strict";
/**
 * 认证与授权：Bearer token 会话 + 角色检查。
 * 角色：admin（模板管理/签署）、engineer（录入/处置）、inspector（复检/签署）。
 */
const crypto = require("crypto");
const express = require("express");
const { db, save, audit } = require("./store");
const { verifyPassword, now } = require("./util");

const SIGN_ROLES = ["admin", "inspector"]; // 具有签署资格的角色

function publicUser(u) {
  return { id: u.id, username: u.username, displayName: u.displayName, roles: u.roles };
}

function findUserByToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = db.tokens.find((t) => t.token === match[1]);
  if (!token) return null;
  return db.users.find((u) => u.id === token.userId) || null;
}

/** 要求已登录 */
function requireAuth(req, res, next) {
  const user = findUserByToken(req);
  if (!user) return res.status(401).json({ error: "未登录或会话已失效" });
  req.user = user;
  next();
}

/** 要求具备任一指定角色（越权返回 403） */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "未登录或会话已失效" });
    if (!req.user.roles.some((r) => roles.includes(r))) {
      audit(req.user, "auth.denied", req.path, null, { need: roles, have: req.user.roles });
      save();
      return res.status(403).json({ error: "越权操作：需要角色 " + roles.join("/") });
    }
    next();
  };
}

function canSign(user) {
  return user.roles.some((r) => SIGN_ROLES.includes(r));
}

const router = express.Router();

router.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = db.users.find((u) => u.username === username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: "用户名或密码错误" });
  }
  const token = crypto.randomBytes(24).toString("hex");
  db.tokens.push({ token, userId: user.id, createdAt: now() });
  audit(user, "auth.login", "user", user.id, {});
  save();
  res.json({ token, user: publicUser(user) });
});

router.post("/logout", requireAuth, (req, res) => {
  const header = req.headers.authorization || "";
  const raw = header.replace(/^Bearer\s+/i, "");
  db.tokens = db.tokens.filter((t) => t.token !== raw);
  save();
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

/** 用户列表（签署人选择等场景），不暴露敏感字段 */
router.get("/users", requireAuth, (req, res) => {
  res.json({ users: db.users.map(publicUser) });
});

module.exports = { router, requireAuth, requireRole, canSign, publicUser, SIGN_ROLES };
