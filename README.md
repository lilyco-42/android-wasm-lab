# android-wasm-lab

Feasibility lab for one question: **can this project's WASM browser build (`onnxruntime-web` +
`u2netp`) actually run on Android, and can it be verified without a physical phone?**

Answer so far: yes, on an API 36 x86_64 emulator with the stock Chrome 133 that ships in the
`google_apis_playstore` image. No extra tooling, no Appium, no npm install.

## Measured (2026-09-18)

| Check | Result |
|---|---|
| Chrome in the emulator image | `com.android.chrome` 133.0.6943.137 |
| Page load | `Rembg Studio · 浏览器版`, purchase card visible |
| Real ort binary | `vendor/ort-wasm-simd-threaded.wasm` = 11,210,254 B → `validate: true`, `compile: ok` |
| `instantiate` | fails on missing imports only (expected without the JS glue) |
| Cold inference | **9.5 s** from clicking 开始 to a finished cutout (site storage wiped first) |
| Output | 710×946, 27.6 % fully transparent, 58.2 % fully opaque |
| Host hints | `deviceMemory: 2` GB, 4 cores, `SharedArrayBuffer: undefined` |

`SharedArrayBuffer` is absent because GitHub Pages sends no COOP/COEP, which is fine here:
`web/worker.mjs` pins `ort.env.wasm.numThreads = 1`. Any future change that enables threads
breaks on the hosted PWA, not on this lab.

## How to run

```bash
# host: start the emulator once and keep the first-run dialogs dismissed
$ANDROID_HOME/emulator/emulator -avd rembg-ci -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect &
adb forward tcp:9222 localabstract:chrome_devtools_remote

node harness/probe.mjs                                   # capability check
node harness/flow.mjs path/to/image.jpg --adb "$(which adb)"   # cold end-to-end run
```

`flow.mjs` wipes site storage before measuring, otherwise the workbench restores its persisted
queue and the timing reports the previous run.

## Traps this lab already paid for

1. A fresh emulator Chrome swallows the first `VIEW` intent behind onboarding (sign-in, then
   notifications). Both must be dismissed; use `-read-only` only if you do not want that to persist.
2. Web content is invisible to `uiautomator` until accessibility is switched on, and even then the
   workbench's previews are id-less `blob:` images — identify the cutout by its alpha channel.
3. `WebAssembly.validate` on hand-typed feature-detect bytes is a trap: a wrong byte array reports
   "no SIMD" on a browser that supports it. Validate the artifact the app really loads.
4. Assigning `input.files` from an in-page `DataTransfer` works, but a large base64 string inlined
   into an evaluated expression does not — pass it as a `Runtime.callFunctionOn` argument.
5. `DOM.setFileInputFiles` with an `/sdcard/...` path fails: scoped storage denies Chrome that read,
   and the Play image cannot `adb root`. Use the in-page injection or the native picker.
6. The native picker is not enough on its own: `#files` is `multiple`, so PhotoPicker needs a
   `Done` tap after selecting.

## Deliberate non-goals

Native WASM runtimes on Android (`wasmtime-android-kt` and friends) were surveyed and dropped: the
shipped Android app already runs ONNX Runtime natively, so a second wasm path would duplicate
existing coverage instead of de-risking the browser build.
