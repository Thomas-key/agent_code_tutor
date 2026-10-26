/**
 * 注册表:模块自己把 op 登记进来。
 *
 * 为什么不是一张中心表:那张表要求中心文件认识所有模块,加一个模块就得改中心。
 * 注册表把方向反过来 —— 中心只提供"登记的地方",模块自己说"我提供什么"。
 *
 * 用 Map 而不是普通对象:名字不走原型链,`ops.get('toString')` 是 undefined,
 * 不需要 hasOwnProperty 那层防御。
 */
function createRegistry() {
  const ops = new Map();

  return {
    /**
     * 登记一个 op。
     * @param {string} name 客户端调用时用的名字
     * @param {{summary: string, run: (request: object, ctx: object) => any}} definition
     */
    add(name, definition) {
      if (!name || typeof name !== 'string') throw new Error('op 名字必须是非空字符串');
      if (typeof definition?.run !== 'function') throw new Error(`op「${name}」缺少 run 函数`);
      if (ops.has(name)) throw new Error(`op「${name}」被登记了两次`);
      ops.set(name, definition);
    },

    /** 按名字取;没有就返回 null,由调用方决定怎么报错。 */
    get(name) {
      return ops.get(name) ?? null;
    },

    /** 所有已登记的名字,按登记顺序(Map 保序)。ping 用它自省。 */
    names() {
      return [...ops.keys()];
    },

    /** 已登记几个。 */
    get size() {
      return ops.size;
    },
  };
}

module.exports = { createRegistry };
