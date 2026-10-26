const net = require('net');

/**
 * 传输层:TCP + 一行一个 JSON。
 *
 * TCP 是**字节流**,不是消息流:对方 write 一次,你可能收到两次 data;write 两次,
 * 你也可能一次收完。所以第一件事不是解析 JSON,是**切分** —— 攒进 buffer,
 * 直到看见换行符,那才是一条完整的消息。
 *
 * 这一层**不认识任何 op 的名字**:op 是 api.js 的事。换协议时只动 api.js。
 */
function createBridge({ port, dispatch }) {
  const sessions = new Set();

  /** 一条连接从建立到断开的全部逻辑。Node 每接受一个连接就调一次。 */
  function handleConnection(socket) {
    // 每个连接一份自己的状态:还没切完的字节、以及它自己的事件游标。
    const session = { socket, cursor: 0, buffer: '' };
    sessions.add(session);
    // 明确按 utf8 解码。不设的话拿到的是 Buffer,一个中文字被切在两个 chunk 之间就废了。
    socket.setEncoding('utf8');

    // 字节流 → 一条条完整消息:每看到一个换行就是一条,剩下的留在 buffer 里等下一块。
    socket.on('data', (chunk) => {
      session.buffer += chunk;
      let index;
      while ((index = session.buffer.indexOf('\n')) >= 0) {
        const line = session.buffer.slice(0, index).trim();
        session.buffer = session.buffer.slice(index + 1);
        // 空行当心跳,不是消息;不 await,否则一条慢请求会卡住后面所有消息。
        if (line) void handleLine(line, session);
      }
    });

    // 客户端粗暴断开是常态(关标签页、进程被杀),不该让扩展跟着崩。
    socket.on('error', () => {});
    socket.on('close', () => {
      sessions.delete(session);
    });
  }

  const server = net.createServer(handleConnection);

  /**
   * 一条完整消息 → 一个响应。
   *
   * 这里只做三件事:解析 / 调 dispatch / 回写。请求里到底有哪些 op、怎么处理,
   * 全部在 dispatch 里面 —— 所以加一个 op 不会动到这个函数。
   */
  async function handleLine(line, session) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      send(session, { ok: false, error: { code: 'bad-json', message: '这一行不是合法 JSON' } });
      return;
    }

    try {
      const body = await dispatch(request, session);
      send(session, { id: request.id, ...body });
    } catch (error) {
      send(session, {
        id: request.id,
        ok: false,
        error: { code: 'internal', message: String(error?.message ?? error) },
      });
    }
  }

  /** 往一条连接写一条消息。连接已断就丢掉 —— 那时已经没人能收。 */
  function send(session, message) {
    const { socket } = session;
    if (socket.destroyed || !socket.writable) return;
    socket.write(JSON.stringify(message) + '\n');
  }

  return {
    /** 开始监听;返回真实端口(port=0 时由内核分配,测试用)。 */
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve(server.address().port);
        });
      });
    },

    /** 给所有连着的客户端各发一条:推送(用户按按钮、改了代码)都走这里。 */
    broadcast(message) {
      for (const session of sessions) send(session, message);
      return sessions.size;
    },

    /** 关掉:先断连接再关监听,否则 server.close 会一直等它们。 */
    close() {
      for (const session of sessions) session.socket.destroy();
      sessions.clear();
      server.close();
    },
  };
}

module.exports = { createBridge };
