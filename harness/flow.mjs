// End-to-end browser inference on the Android emulator.
//
// The image is handed to the page through a CDP call argument rather than string
// interpolation: a base64 blob inside an evaluated expression is easy to corrupt and
// Chrome then silently drops the assignment.
//
//   node flow.mjs <image-path> [--adb <adb>] [--via picker]
//
// Prerequisite: adb forward tcp:9222 localabstract:chrome_devtools_remote
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { connect, pageTargetUrl } from './cdp.mjs';

const adbArg = process.argv.indexOf('--adb');
const ADB = adbArg > -1 ? process.argv[adbArg + 1] : 'adb';
const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8', maxBuffer: 8 << 20 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const imagePath = process.argv[2];
const usePicker = process.argv.includes('--via');

if (!imagePath || imagePath.startsWith('--')) {
  console.error('usage: node flow.mjs <image-path> [--adb <adb>] [--via-picker]');
  process.exit(2);
}

const URL_TO_OPEN = 'https://lilyco-42.github.io/rembg/';
const stateExpr = `(JSON.stringify({
  files: document.getElementById('files').files.length,
  status: (document.getElementById('status')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
}))`;

const alphaExpr = `(() => {
  // The workbench renders source and result as id-less blob: images, so the only
  // reliable way to tell the cutout apart is its alpha channel.
  const stats = [];
  for (const target of [...document.querySelectorAll('canvas'), ...document.querySelectorAll('img')]) {
    const width = target.naturalWidth || target.width;
    const height = target.naturalHeight || target.height;
    if (!width || !height) continue;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(target, 0, 0);
    let transparent = 0;
    let opaque = 0;
    try {
      const { data } = ctx.getImageData(0, 0, width, height);
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] === 0) transparent += 1;
        else if (data[i] === 255) opaque += 1;
      }
    } catch (error) { continue; }
    const total = width * height;
    stats.push({ width, height, transparentPct: +(100 * transparent / total).toFixed(1), opaquePct: +(100 * opaque / total).toFixed(1) });
  }
  const cutout = stats.filter((s) => s.transparentPct > 5).sort((a, b) => b.transparentPct - a.transparentPct)[0];
  return cutout ? { ...cutout, candidates: stats.length } : { candidates: stats.length, none: true };
})()`;

async function chooseViaNativePicker(page) {
  const box = JSON.parse(await page.evaluate(`(() => {
    const input = document.getElementById('files');
    const el = input.closest('label') || input;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`));
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  }
  await sleep(6000);
  adb('shell', 'uiautomator', 'dump', '/sdcard/lab-ui.xml');
  const xml = adb('shell', 'cat', '/sdcard/lab-ui.xml');
  const photo = /content-desc="(Photo taken[^"]*)"[^>]*bounds="\[(\d+),(\d+)\],?\[(\d+),(\d+)\]"/.exec(xml);
  if (!photo) throw new Error('picker did not open, or exposes no photos');
  adb('shell', 'input', 'tap', String(Math.round((+photo[2] + +photo[4]) / 2)), String(Math.round((+photo[3] + +photo[5]) / 2)));
  await sleep(2000);
  adb('shell', 'uiautomator', 'dump', '/sdcard/lab-ui.xml');
  const after = adb('shell', 'cat', '/sdcard/lab-ui.xml');
  const done = /(?:content-desc|text)="(Done|Add|完成|添加)"[^>]*bounds="\[(\d+),(\d+)\],?\[(\d+),(\d+)\]"/.exec(after);
  if (done) adb('shell', 'input', 'tap', String(Math.round((+done[2] + +done[4]) / 2)), String(Math.round((+done[3] + +done[5]) / 2)));
  await sleep(6000);
}

const { wsUrl } = await pageTargetUrl();
const page = await connect(wsUrl, { timeoutMs: 45_000 });
await page.send('Runtime.enable');
await page.send('DOM.enable');
await page.send('Page.enable');

// The workbench persists its queue, so a reload alone would report the previous
// run's result and make the timing meaningless. Wipe site storage first.
await page.send('Page.navigate', { url: URL_TO_OPEN });
await sleep(8000);
const origin = await page.evaluate('location.origin');
await page.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
await page.send('Page.navigate', { url: URL_TO_OPEN });
await sleep(12_000);

if (usePicker) {
  await chooseViaNativePicker(page);
} else {
  const base64 = readFileSync(imagePath).toString('base64');
  const { result } = await page.send('Runtime.evaluate', { expression: `document.getElementById('files')` });
  const injected = await page.send('Runtime.callFunctionOn', {
    objectId: result.objectId,
    functionDeclaration: `function (b64, name) {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name, { type: 'image/jpeg' }));
      this.files = transfer.files;
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return this.files.length;
    }`,
    arguments: [{ value: base64 }, { value: 'lab-input.jpg' }],
    returnByValue: true,
  });
  console.log('injected files on input:', injected.result?.value);
}

console.log('after pick:', JSON.parse(await page.evaluate(stateExpr)));

await page.evaluate(`document.getElementById('run').click()`);
const startedAt = Date.now();
let output = null;
let lastStatus = '';
while (Date.now() - startedAt < 300_000) {
  await sleep(3000);
  lastStatus = JSON.parse(await page.evaluate(stateExpr)).status;
  output = await page.evaluate(alphaExpr);
  if (output && !output.none) break;
}

console.log(JSON.stringify({ seconds: +((Date.now() - startedAt) / 1000).toFixed(1), status: lastStatus, output }, null, 2));
if (!output) console.error('no rendered output within the timeout');
page.close();
