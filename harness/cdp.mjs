// Zero-dependency Chrome DevTools Protocol client over the adb-forwarded socket.
// Node >= 21 provides a global WebSocket, so no npm install is needed.
const OPEN = 1;

export async function connect(wsUrl = 'ws://127.0.0.1:9222/devtools/page/1', { timeoutMs = 60_000 } = {}) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 0;

  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const waiter = msg.id && pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      waiter(msg);
    }
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP socket error')));
    setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (msg) => {
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method}: response timeout`));
    }, timeoutMs);
  });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`page threw: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ''}`.trim());
    }
    return res.result?.value;
  };

  return {
    send,
    evaluate,
    close: () => socket.close(),
    readyState: () => socket.readyState === OPEN,
  };
}

export async function pageTargetUrl(base = 'http://127.0.0.1:9222') {
  const res = await fetch(`${base}/json`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target; is the PWA open in Chrome?');
  return { url: page.url, title: page.title, wsUrl: page.webSocketDebuggerUrl };
}
