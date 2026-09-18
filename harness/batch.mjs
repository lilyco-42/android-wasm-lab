// Batch throughput + memory curve for the browser build on the Android emulator.
//
//   node batch.mjs <image-path> [--batch N] [--adb <adb>]
//
// Prerequisite: adb forward tcp:9222 localabstract:chrome_devtools_remote
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { connect, pageTargetUrl } from './cdp.mjs';

const argValue = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const ADB = argValue('--adb', 'adb');
const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8', maxBuffer: 8 << 20 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const imagePath = process.argv[2];
const count = Number(argValue('--batch', '10'));
if (!imagePath || imagePath.startsWith('--')) {
  console.error('usage: node batch.mjs <image-path> [--batch N] [--adb <adb>]');
  process.exit(2);
}

const URL_TO_OPEN = 'https://lilyco-42.github.io/rembg/';

// Count rendered cutouts by their alpha channel: the workbench previews are id-less
// blob: images, so there is no attribute that distinguishes source from result.
const progressExpr = `(() => {
  let cutouts = 0;
  const media = [...document.querySelectorAll('img'), ...document.querySelectorAll('canvas')];
  for (const target of media) {
    const width = target.naturalWidth || target.width;
    const height = target.naturalHeight || target.height;
    if (!width || !height) continue;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(target, 0, 0);
    let transparent = 0;
    try {
      const { data } = ctx.getImageData(0, 0, width, height);
      for (let i = 3; i < data.length; i += 4) if (data[i] === 0) transparent += 1;
      if (transparent / (width * height) > 0.05) cutouts += 1;
    } catch (error) { /* tainted or unreadable frame, ignore */ }
  }
  return JSON.stringify({
    cutouts,
    status: (document.getElementById('status') || {}).textContent || '',
  });
})()`;

const chromePssKB = () => {
  try {
    const out = adb('shell', 'dumpsys', 'meminfo', 'com.android.chrome');
    const match = /TOTAL PSS:\s+(\d+)/.exec(out);
    return match ? Math.round(Number(match[1]) / 1024) : null;
  } catch (error) {
    return null;
  }
};

const { wsUrl } = await pageTargetUrl();
const page = await connect(wsUrl, { timeoutMs: 60_000 });
await page.send('Page.enable');

await page.send('Page.navigate', { url: URL_TO_OPEN });
await sleep(8000);
const origin = await page.evaluate('location.origin');
await page.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
await page.send('Page.navigate', { url: URL_TO_OPEN });
await sleep(12_000);

const base64 = readFileSync(imagePath).toString('base64');
const { result } = await page.send('Runtime.evaluate', { expression: `document.getElementById('files')` });
const injected = await page.send('Runtime.callFunctionOn', {
  objectId: result.objectId,
  functionDeclaration: `function (b64, name, total) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    const stem = name.replace(/\\.[a-z]+$/i, '');
    for (let i = 0; i < total; i += 1) {
      transfer.items.add(new File([bytes], stem + '-' + i + '.jpg', { type: 'image/jpeg' }));
    }
    this.files = transfer.files;
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return 'dispatched ' + transfer.files.length;
  }`,
  arguments: [{ value: base64 }, { value: 'lab.jpg' }, { value: count }],
  returnByValue: true,
});
console.log(`injecting ${count} files:`, injected.result?.value);
await sleep(3000);

await page.evaluate(`document.getElementById('run').click()`);
const startedAt = Date.now();
const samples = [];
let done = null;
while (Date.now() - startedAt < 900_000) {
  await sleep(5000);
  const progress = JSON.parse(await page.evaluate(progressExpr));
  samples.push({ t: +((Date.now() - startedAt) / 1000).toFixed(0), cutouts: progress.cutouts, pssMB: chromePssKB() });
  if (progress.cutouts >= count) {
    done = progress;
    break;
  }
}

const seconds = +((Date.now() - startedAt) / 1000).toFixed(1);
const summary = {
  requested: count,
  completed: done ? done.cutouts : samples.at(-1)?.cutouts ?? 0,
  seconds,
  perImage: done ? +(seconds / count).toFixed(2) : null,
  peakPssMB: Math.max(...samples.map((s) => s.pssMB ?? 0)) || null,
  status: (done?.status || '').replace(/\s+/g, ' ').slice(0, 160),
};
console.log('SUMMARY ' + JSON.stringify(summary));
console.log(JSON.stringify({ ...summary, samples }, null, 2));
page.close();
