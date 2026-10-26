/**
 * API 层:分发。
 *
 * 这里**不认识任何业务模块** —— 它只认识 registry。有哪些 op、由谁登记而来,
 * 这个文件完全不需要知道。加能力 = 别的模块调用 registry.add(),这里一行不动。
 */

const VERSION = '1.0.0';

/**
 * 服务自身的 op:它们描述"这个 API 有什么",不属于任何业务模块。
 *
 * ping 之所以归这里,是因为它对任何编辑器状态都无感 —— 换成别的客户端、
 * 换成另一个项目,ping 的语义都不变。
 */
function registerBuiltins(registry) {
  registry.add('ping', {
    summary: '连通性检查;顺带返回支持哪些 op',
    run: (request, ctx) => ({ version: ctx.version, port: ctx.port, ops: registry.names() }),
  });
}

/**
 * 一个请求 → 一个响应体。
 *
 * 这里**不抛异常**:所有失败都变成 {ok:false, error}。抛出去会被传输层当成
 * internal —— 那条通道是留给"我们自己的 bug"的,不该混进普通的调用失败。
 */
function createDispatch({ registry, version, port }) {
  return async function dispatch(request, session) {
    const op = request?.op;
    // registry 是 Map:名字不走原型链,所以不需要 hasOwnProperty 那层防御。
    const entry = typeof op === 'string' ? registry.get(op) : null;
    if (!entry) {
      return { ok: false, error: { code: 'unknown-op', message: `没有这个 op:${String(op)}` } };
    }

    try {
      return { ok: true, result: await entry.run(request, { session, version, port }) };
    } catch (error) {
      return { ok: false, error: { code: 'op-failed', message: String(error?.message ?? error) } };
    }
  };
}

module.exports = { createDispatch, registerBuiltins, VERSION };
