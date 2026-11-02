#!/usr/bin/env node
/**
 * 参考客户端 —— "别人怎么接进来"的活样本。
 *
 * 三件事值得学:
 *   ① 每个请求都带 token(不带会被服务端拒)
 *   ② 没有 id 的消息是推送,不能塞进请求配对表
 *   ③ 一次 data 可能只带回半条消息 —— 必须自己切行
 */

const net = require('net');

/**
 * 连接编辑器 API。
 *
 * 为什么要查自环:扩展宿主重启的瞬间,如果客户端去连一个"刚释放、还没重新监听"的端口,
 * 内核可能把这次连接合成一条 127.0.0.1:P → 127.0.0.1:P 的 socket。它看起来是连上了,
 * 但你写进去的请求会被自己收回来 —— 于是一直等一个永远不会来的真响应。
 *
 * `localPort === remotePort` 就是这个特征的判据。
 */
function connect(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host });

    socket.once('connect', () => {
      socket.off('error', onError);
      if (socket.localPort === socket.remotePort) {
        socket.destroy();
        reject(new Error(`端口 ${port} 上有自环 socket(连到了自己)`));
        return;
      }
      socket.setEncoding('utf8');
      resolve(socket);
    });

    function onError(error) {
      socket.destroy();
      reject(new Error(`连不上 ${host}:${port} —— ${error.code ?? error.message}`));
    }
    socket.once('error', onError);
  });
}


/**
 * 把一条已经连上的 socket 包成"能发请求"的客户端。
 *
 * 请求带自增 id,响应按 id 配对 —— 所以回复顺序无所谓:
 * 一条 `wait` 挂着的时候,同一个连接上的 `ping` 照样能立刻回来。
 */
function createClient(socket, token = 'test') {
  let buffer = '';
  let nextId = 1;
  const pending = new Map(); // id → { resolve, reject }
  const listeners = new Set(); // 推送的处理函数

  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // 坏行丢掉,不该让整个客户端崩
      }
      // 没有 id = 推送(服务端主动说的)
      if (message.id === undefined) {
        for (const listener of listeners) listener(message);
        continue;
      }
      const entry = pending.get(message.id);
      if (!entry) continue; // 迟到的响应:请求早就结束了
      pending.delete(message.id);
      if (message.ok) {
        // 给的是**整个信封** —— 除了 result,还可能带 scene / events
        entry.resolve(message);
      } else {
        const error = new Error(message.error?.message ?? '调用失败');
        error.code = message.error?.code;
        entry.reject(error);
      }
    }
  });

  return {
    /**
     * 发一个请求,等它的响应。
     *
     * token 跟着每个请求走 —— 这是协议的一部分,不是可选项。
     *
     * @returns {Promise<{result: any, scene?: object, events?: object}>} 整个信封
     */
    request(op, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.write(JSON.stringify({ id, token, op, ...params }) + '\n');
      });
    },

    /** 收推送。 */
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    close() {
      socket.end();
    },
  };
}


/**
 * 命令行入口:
 *
 *   node examples/client.js 41890 ping
 *   node examples/client.js 41890 scene
 *   TUTOR_API_TOKEN=test node examples/client.js 41890 read
 *
 * token 从环境变量 `TUTOR_API_TOKEN` 读,默认 `test`(和工作区设置里的一致才能通)。
 */
async function main() {
  const port = Number(process.argv[2] || 41890);
  const op = process.argv[3] || 'ping';
  const token = process.env.TUTOR_API_TOKEN ?? 'test';

  const socket = await connect(port);
  const client = createClient(socket, token);
  client.onEvent((event) => console.log('← 推送', JSON.stringify(event)));

  try {
    const response = await client.request(op);
    console.log('← result', JSON.stringify(response.result));
    if (response.scene) console.log('← scene ', JSON.stringify(response.scene));
    if (response.events) console.log('← events', JSON.stringify(response.events));
  } catch (error) {
    console.log('✗', error.code ? `[${error.code}]` : '', error.message);
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('✗', error.message);
    process.exit(1);
  });
}

module.exports = { connect, createClient, main };
