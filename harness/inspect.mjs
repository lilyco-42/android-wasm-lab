import { connect, pageTargetUrl } from './cdp.mjs';

const { wsUrl } = await pageTargetUrl();
const page = await connect(wsUrl, { timeoutMs: 20000 });
const expression = `JSON.stringify({
  media: [...document.querySelectorAll('img,canvas')].map((el) => ({
    tag: el.tagName,
    id: el.id,
    cls: String(el.className).slice(0, 40),
    w: el.naturalWidth || el.width,
    h: el.naturalHeight || el.height,
    src: (el.src || '').slice(0, 30),
  })),
  status: (document.getElementById('status') || {}).textContent,
  buttons: [...document.querySelectorAll('button')].map((b) => b.id + ':' + b.textContent.trim().slice(0, 10) + (b.disabled ? '(off)' : '')),
}, null, 1)`;
console.log(await page.evaluate(expression));
page.close();
