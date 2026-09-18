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
| Batch of 10 | run A **40 s**, run B **37.1 s** → ≈3.7 s per image; Chrome peak `TOTAL PSS` 97 MB (A) / **119 MB** (B) |
| Output | 710×946, 27.6 % fully transparent, 58.2 % fully opaque |
| Host hints | `deviceMemory: 2` GB, 4 cores, `SharedArrayBuffer: undefined` |

Batch curve (run A — `harness/batch.mjs --batch 10`, same image repeated, AVD `rembg-ci` x86_64,
2 GB RAM, 4 cores, single-threaded WASM, u2netp; run B is a separate clean rerun):

| t (s) | cutouts rendered | Chrome PSS (MB) |
|---|---|---|
| 15 | 2 | 80 |
| 21 | 4 | 84 |
| 28 | 6 | 89 |
| 34 | 8 | 96 |
| 40 | 10 | 97 |

Memory climbs roughly linearly and never spikes, i.e. the queue releases each bitmap; the
throughput is steady at ~3.4 s/image after model load. These are emulator numbers on x86_64
with software GL and are **not** a substitute for an ARM phone measurement.

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
node harness/batch.mjs path/to/image.jpg --batch 10 --adb "$(which adb)"  # throughput + PSS curve
node harness/native-batch.mjs --pick 10 --adb "$(which adb)"    # native app, see "Not finished here"
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
7. `uiautomator` bounds are `"[x1,y1][x2,y2]"` — a regex written as `\[d,d[,]]+d,d\]` silently
   matches nothing, which looks exactly like "the button never appeared".
8. Matching Chinese `text=` values read back through `adb shell` is unreliable (console codepage);
   locate native views by `resource-id` and read progress from the ASCII digits in the text.
9. `adb push`/`pull` paths must be relative or Windows-style once `MSYS_NO_PATHCONV=1` is set,
   otherwise Git-Bash paths get rewritten into `C:/Program Files/Git/...`.

## Not finished here

`harness/native-batch.mjs` is the same 10-image measurement for the Kotlin/ONNX-Runtime app on the
same AVD, so browser vs native can be compared apples to apples. It reaches and taps 批量选图 but
the picker step was never completed before the emulator session ended, so **it is unverified past
that point** and no native numbers are claimed. Running it needs an emulator, which is deliberately
left off on a weak host.

## Deliberate non-goals

Native WASM runtimes on Android (`wasmtime-android-kt` and friends) were surveyed and dropped: the
shipped Android app already runs ONNX Runtime natively, so a second wasm path would duplicate
existing coverage instead of de-risking the browser build.
