// Capability probe: asks the live page whether it can run this project's real
// ort wasm build, instead of hand-written feature-detect byte arrays (those are
// easy to get wrong and produce false negatives).
import { connect, pageTargetUrl } from './cdp.mjs';

const { url, title, wsUrl } = await pageTargetUrl();
const page = await connect(wsUrl);

const report = await page.evaluate(`(async () => {
  const wasmUrl = new URL('vendor/ort-wasm-simd-threaded.wasm', location.href).href;
  const bytes = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
  let compile = 'ok';
  try { await WebAssembly.compile(bytes); } catch (error) { compile = String(error).slice(0, 140); }
  let instantiate = 'ok';
  try { await WebAssembly.instantiate(bytes, {}); } catch (error) { instantiate = String(error).slice(0, 140); }
  return {
    page: { url: location.href, title: document.title },
    wasm: { file: wasmUrl.split('/').pop(), bytes: bytes.length, validate: WebAssembly.validate(bytes), compile, instantiate },
    host: {
      sharedArrayBuffer: typeof SharedArrayBuffer,
      deviceMemoryGB: navigator.deviceMemory ?? null,
      cpuCores: navigator.hardwareConcurrency ?? null,
      userAgent: navigator.userAgent,
    },
  };
})()`);

console.log(JSON.stringify(report, null, 2));
page.close();
if (!report.page.url.includes(url.split('/').slice(3).join('/'))) console.warn('note: probe ran against a different tab than detected');
