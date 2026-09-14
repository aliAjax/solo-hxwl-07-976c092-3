"use strict";
/* 离线队列与同步冲突的纯函数模块：浏览器（window.Offline）与 Node 测试（require）共用。
 * 核心约定：离线操作记录"编辑时的服务器基线 baseResult"，同步时三方比对——
 *   服务器值 == 离线新值        → noop（内容已一致，直接丢弃队列）
 *   服务器值 == 基线（未被动过） → apply（可安全提交）
 *   其余                        → conflict（他人已改，保留双方，必须用户明示选择，禁止静默覆盖）
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  if (root) root.Offline = mod;
})(typeof self !== "undefined" ? self : globalThis, function () {
  function normResult(r) {
    if (!r) return null;
    return { status: r.status || "", value: r.value || "", notes: r.notes || "" };
  }

  function resultsEqual(a, b) {
    const x = normResult(a);
    const y = normResult(b);
    if (!x && !y) return true;
    if (!x || !y) return false;
    return x.status === y.status && x.value === y.value && x.notes === y.notes;
  }

  /** 把离线队列叠加到实例结果上（仅用于展示，不改服务器数据） */
  function applyOps(instance, ops) {
    const merged = JSON.parse(JSON.stringify(instance));
    for (const op of ops || []) {
      if (op.insId !== merged.id) continue;
      merged.results[op.itemCode] = {
        status: op.status,
        value: op.value || "",
        notes: op.notes || "",
        updatedBy: "离线未同步",
        updatedAt: new Date(op.at || Date.now()).toISOString(),
        offline: true,
      };
    }
    return merged;
  }

  /**
   * 生成同步计划。ops: 离线操作队列；serverInstance: 服务器当前实例。
   * 返回 { apply: [op], noop: [op], conflict: [{op, server}] }
   */
  function planSync(ops, serverInstance) {
    const plan = { apply: [], noop: [], conflict: [] };
    const serverResults = (serverInstance && serverInstance.results) || {};
    for (const op of ops || []) {
      const server = serverResults[op.itemCode] || null;
      if (resultsEqual(server, op)) {
        plan.noop.push(op); // 服务器已与离线值一致（他人提交了相同内容）
      } else if (resultsEqual(server, op.baseResult || null)) {
        plan.apply.push(op); // 服务器未动过该项，可安全提交
      } else {
        plan.conflict.push({ op, server: normResult(server) }); // 他人已改：保留双方，交给用户选择
      }
    }
    return plan;
  }

  return { normResult, resultsEqual, applyOps, planSync };
});
