#!/usr/bin/env node
/**
 * 开发用的最小入口 —— 不是给 VS Code 用的。
 *
 * 它只做一件事:把 bridge / registry / api 接起来,监听一个测试端口,
 * 让第 1 步能在没有 VS Code 的情况下跑起来。
 * 等 src/extension.js 写好,它就退休(留着当冒烟测试也行)。
 */

const { createBridge } = require('./bridge');
const { createRegistry } = require('./registry');
const { createDispatch, registerBuiltins, VERSION } = require('./api');

// 41889:和真扩展的 41888 错开,两个可以同时跑
const PORT = Number(process.env.TUTOR_DEV_PORT || 41889);

async function main() {
  const registry = createRegistry();
  registerBuiltins(registry); // 以后:registerSense(registry) / registerActions(registry) …

  const bridge = createBridge({
    port: PORT,
    dispatch: createDispatch({ registry, version: VERSION, port: PORT }),
  });

  const actual = await bridge.listen();
  console.log(`dev-server 在 127.0.0.1:${actual}`);
  console.log(`已登记的 op:${registry.names().join(', ')}`);

  const stop = () => {
    bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  console.error('启动失败:', error.message);
  process.exit(1);
});
