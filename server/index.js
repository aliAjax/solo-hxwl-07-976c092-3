"use strict";
const path = require("path");
const express = require("express");
const { load } = require("./store");
const auth = require("./auth");
const templates = require("./templates");
const instances = require("./instances");
const packages = require("./packages");

load(); // 启动即加载/初始化数据

const app = express();
app.use(express.json({ limit: "30mb" })); // 附件走 base64，放宽限制

app.use("/api/auth", auth.router);
app.use("/api/templates", templates.router);
app.use("/api/instances", instances.router);
app.use("/api", packages.router);

app.get("/api/health", (req, res) => res.json({ ok: true, at: new Date().toISOString() }));

// 前端静态资源（原生 SPA，无需构建）
app.use(express.static(path.join(__dirname, "..", "public")));

// JSON 解析失败等业务外错误统一处理
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "请求体不是合法 JSON" });
  }
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ error: "请求体过大" });
  }
  console.error(err);
  res.status(500).json({ error: "服务器内部错误" });
});

const PORT = Number(process.env.PORT || 5107);
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`航空维修检查协作台已启动: http://localhost:${PORT}`);
  });
}

module.exports = app; // 供测试以随机端口挂载
