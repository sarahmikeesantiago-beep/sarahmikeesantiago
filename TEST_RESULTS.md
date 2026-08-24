# Test results — ruyi-web-v1.1.1

- Status: **PASS**
- Measured: 2026-08-24 (Asia/Shanghai)
- Baseline before this release: 38e56f4bfafaebab96a3c191d8e4642b9f499607
- Host: Windows 11 Pro 10.0.26200
- Node.js: 24.16.0
- Browser: Microsoft Edge / Chromium 151.0.4129.93
- Playwright: 1.62.1
- Command: npm test

## Results

| Suite | Result | Evidence |
| --- | --- | --- |
| Protocol self-test | PASS | 4/4 |
| Transport safety | PASS | 11 checks, including pending SIGNAL and pending STOP rejection after physical disconnect |
| Browser + simulated WebHID | PASS | 17 checks |
| Zero-output diagnostics | PASS | 12 checks |
| Interaction | PASS | knob frequency 96 Hz in the deterministic gesture; surface rotation reset |
| Visual/layout | PASS | 5 screenshots |
| Static deployment smoke | PASS | 4 chapters, protocol 4/4, diagnostics loaded |
| Overall | PASS | physicalHid: not-used |

The diagnostics test observed the deterministic synthetic trace values
stationaryDriftRadiusPx = 10 and pointerMoveStepDistanceP95Px = 5. It also
verified getDevices = 1, requestDevice = 0, open = 0, and sendReport = 0.

## Boundary

These are software regression results. HID behavior is simulated or replaced
with an explicit empty-device list. No physical HID device was connected,
opened, or written by this suite. The results do not validate actuator output,
firmware timeout-to-zero behavior, physical safety, or the Ruyi head unit
runtime. Those remain real-device acceptance tests.