/**
 * API 层:分发 + 响应装配。
 *
 * 它只认识 registry 和可选的 viewFor(场景提供者)—— 不认识任何业务模块。
 */

const VERSION = '1.0.0';

/**
 * 一个请求 → 一个响应体。
 *
 * 这里**不抛异常**:所有失败都变成 {ok:false, error}。抛出去会被传输层当成
 * internal —— 那条通道是留给"我们自己的 bug"的,不该混进普通的调用失败。
 */
function createDispatch({ registry, version, viewFor, getToken }) {
  /**
   * 按需把场景挂到响应上。
   *
   * 带:有待办事件(人做了什么),或者出错(帮它自己纠错)。
   * 事件是**通知**:viewFor 取走就清空,不会重复给。
   */
  function attach(body, force) {
    if (!viewFor) return body;
    const view = viewFor({ force });
    if (!view) return body;
    return { ...body, scene: view.scene, events: view.events };
  }

  return async function dispatch(request, session) {
    // 会话身份:每个请求都要带 token。不一致 = 这个工作区不该被它操作。
    if (getToken) {
      const expected = String(getToken() ?? '');
      const given = String(request?.token ?? '');
      if (!expected) {
        return {
          ok: false,
          error: { code: 'op-failed', message: '工作区还没生成会话 token(设置里 tutorApi.conversationToken 是空的)' },
        };
      }
      // 记住这条连接"属于"哪个会话 —— 推送时按它找
      session.lastToken = given;
      if (given !== expected) {
        return {
          ok: false,
          error: {
            code: 'op-failed',
            message: 'token 不匹配 —— 这个工作区不属于你。要么把客户端的 token 改成工作区设置里的值,要么用匹配的会话',
          },
        };
      }
    }

    const op = request?.op;
    // registry 是 Map:名字不走原型链,所以不需要 hasOwnProperty 那层防御。
    const entry = typeof op === 'string' ? registry.get(op) : null;
    if (!entry) {
      return attach(
        { ok: false, error: { code: 'unknown-op', message: `没有这个 op:${String(op)}` } },
        true,
      );
    }

    try {
      const result = await entry.run(request, { session, version });
      return attach({ ok: true, result }, false);
    } catch (error) {
      return attach(
        { ok: false, error: { code: 'op-failed', message: String(error?.message ?? error) } },
        true,
      );
    }
  };
}

module.exports = { createDispatch, VERSION };
