// Native-app counterpart of batch.mjs, on the same AVD, so the browser path and the
// Kotlin/ONNX-Runtime path are compared under identical conditions.
//
//   node native-batch.mjs --adb <adb> [--pick 10]
//
// Nodes are located by ASCII resource-id and bounds use the real uiautomator shape
// "[x1,y1][x2,y2]"; matching on Chinese labels is unreliable because `adb shell`
// output arrives through the console codepage.
import { execFileSync } from 'node:child_process';

const argValue = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const ADB = argValue('--adb', 'adb');
const PKG = 'com.lilyco42.rembgui';
const WANT = Number(argValue('--pick', '10'));
const BOUNDS = String.raw`\[\s*(\d+)\s*,\s*(\d+)\s*\]\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]`;
const adb = (...args) => execFileSync(ADB, ['shell', ...args], { encoding: 'utf8', maxBuffer: 16 << 20 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const uiDump = () => {
  adb('uiautomator', 'dump', '/sdcard/native-ui.xml');
  return adb('cat', '/sdcard/native-ui.xml');
};

const center = (m) => ({ x: Math.round((+m[1] + +m[3]) / 2), y: Math.round((+m[2] + +m[4]) / 2) });

const nodeByResourceId = (xml, id) => {
  const m = new RegExp(`resource-id="${PKG}:id/${id}"[^>]*bounds="${BOUNDS}"`).exec(xml);
  return m ? center(m) : null;
};

const statusText = (xml) => {
  const m = new RegExp(`resource-id="${PKG}:id/batchStatus"[^>]*text="([^"]*)"`).exec(xml);
  return m ? m[1] : '';
};

const photosInPicker = (xml) => {
  const re = new RegExp(String.raw`content-desc="Photo taken[^"]*"[^>]*bounds="${BOUNDS}"`, 'gi');
  return [...xml.matchAll(re)].map(center);
};

const tap = (node) => adb('input', 'tap', String(node.x), String(node.y));
const pssMB = () => {
  const m = /TOTAL PSS:\s+(\d+)/.exec(adb('dumpsys', 'meminfo', PKG));
  return m ? Math.round(Number(m[1]) / 1024) : null;
};

adb('am', 'force-stop', PKG);
adb('pm', 'clear', PKG);
adb('monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1');

let pick = null;
for (let i = 0; i < 25 && !pick; i += 1) {
  await sleep(2000);
  pick = nodeByResourceId(uiDump(), 'batchPickBtn');
}
if (!pick) throw new Error('batchPickBtn never appeared');
tap(pick);
await sleep(7000);

const photos = photosInPicker(uiDump());
if (!photos.length) throw new Error('picker exposed no photos');
for (const photo of photos.slice(0, WANT)) {
  tap(photo);
  await sleep(900);
}
await sleep(1500);

const dumpWithDone = uiDump();
const doneMatch = new RegExp(String.raw`content-desc="Done"[^>]*bounds="${BOUNDS}"`).exec(dumpWithDone);
if (!doneMatch) throw new Error('no Done button in the picker');
tap(center(doneMatch));
await sleep(7000);

const selectedCount = Number((statusText(uiDump()).match(/\d+/) || [WANT])[0]) || WANT;
const run = nodeByResourceId(uiDump(), 'batchRunBtn');
if (!run) throw new Error('batchRunBtn not found after picking');
const startedAt = Date.now();
tap(run);

const samples = [];
let lastDigits = '';
let stableFor = 0;
let finished = false;
while (Date.now() - startedAt < 900_000) {
  await sleep(5000);
  const text = statusText(uiDump());
  const digits = (text.match(/\d+/g) || []).join('/');
  samples.push({ t: Math.round((Date.now() - startedAt) / 1000), digits, pssMB: pssMB() });
  const first = Number((digits.split('/')[0] || '0'));
  finished = first >= selectedCount && digits === lastDigits;
  stableFor = digits === lastDigits ? stableFor + 1 : 0;
  lastDigits = digits;
  if (finished || stableFor >= 4) break;
}

const seconds = +((Date.now() - startedAt) / 1000).toFixed(1);
console.log('SUMMARY ' + JSON.stringify({
  path: 'native',
  requested: selectedCount,
  completed: finished,
  seconds,
  perImage: +(seconds / (selectedCount || 1)).toFixed(2),
  peakPssMB: Math.max(...samples.map((s) => s.pssMB ?? 0)) || null,
  samples: samples.slice(-5),
}));
