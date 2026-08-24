const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { launchChromium } = require("./test-runtime.cjs");

const BASE_URL = process.env.DIAGNOSTICS_TEST_URL || "http://127.0.0.1:4173";

function nearlyEqual(actual, expected, tolerance = 0.01) {
  assert.ok(Math.abs(actual - expected) <= tolerance, "expected " + actual + " to be within " + tolerance + " of " + expected);
}

async function run() {
  const scriptSource = fs.readFileSync(path.resolve(__dirname, "..", "diagnostics.js"), "utf8");
  const htmlSource = fs.readFileSync(path.resolve(__dirname, "..", "diagnostics.html"), "utf8");
  assert.doesNotMatch(scriptSource, /\brequestDevice\s*\(/);
  assert.doesNotMatch(scriptSource, /\.open\s*\(/);
  assert.doesNotMatch(scriptSource, /\bsendReport\s*\(/);
  assert.doesNotMatch(htmlSource, /(?:haptic-protocol|webhid-transport|app)\.js/);
  assert.match(htmlSource, /src="diagnostics\.js"/);

  const browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1024, height: 820 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });

  await page.addInitScript(() => {
    const counters = { getDevices: 0, requestDevice: 0, open: 0, sendReport: 0 };
    const device = {
      vendorId: 0x674e,
      productId: 0x0003,
      productName: "Read-only Mock HID",
      opened: false,
      collections: [{
        usagePage: 1,
        usage: 2,
        inputReports: [],
        featureReports: [],
        outputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }],
        children: []
      }],
      async open() {
        counters.open += 1;
        throw new Error("diagnostics must not open");
      },
      async sendReport() {
        counters.sendReport += 1;
        throw new Error("diagnostics must not send");
      }
    };
    const hid = {
      async getDevices() {
        counters.getDevices += 1;
        return [device];
      },
      async requestDevice() {
        counters.requestDevice += 1;
        throw new Error("diagnostics must not request");
      }
    };
    Object.defineProperty(navigator, "hid", { configurable: true, value: hid });
    Object.defineProperty(window, "__diagnosticsCounters", { configurable: true, value: counters });
  });

  await page.goto(BASE_URL + "/diagnostics.html", { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#environmentGrid")?.children.length > 10);
  assert.match(await page.locator(".safe-badge").textContent(), /零触觉输出/);
  assert.deepEqual(await page.evaluate(() => window.__diagnosticsCounters), {
    getDevices: 0,
    requestDevice: 0,
    open: 0,
    sendReport: 0
  });

  const initial = await page.evaluate(() => window.HapticDiagnostics.buildSnapshot());
  assert.equal(initial.buildRevision, "ruyi-web-v1.1.0");
  assert.equal(initial.diagnosticsSchemaVersion, "ruyi-input-diagnostics-v2");
  assert.equal(initial.schemaVersion, "ruyi-input-diagnostics-v2");
  assert.equal(initial.pointerSummary.stationaryTest.status, "not-started");
  assert.equal(initial.pointerSummary.pointerMoveStepDistanceP95Px, null);

  const pad = page.locator("#pointerPad");
  await pad.scrollIntoViewIfNeeded();
  const box = await pad.boundingBox();
  if (!box) throw new Error("diagnostic pointer pad missing");
  const eventFor = (pointerId, x, y, extras = {}) => Object.assign({
    pointerId,
    pointerType: "touch",
    isPrimary: true,
    bubbles: true,
    pressure: 0.5,
    width: 12,
    height: 14,
    clientX: box.x + x,
    clientY: box.y + y
  }, extras);

  await page.locator("#stationaryTestButton").click();
  await pad.dispatchEvent("pointerdown", eventFor(7, 80, 90, { buttons: 1 }));
  await pad.dispatchEvent("pointermove", eventFor(7, 83, 94, { buttons: 1 }));
  await pad.dispatchEvent("pointermove", eventFor(7, 86, 98, { buttons: 1 }));
  await pad.dispatchEvent("pointerup", eventFor(7, 86, 98, { buttons: 0 }));
  await pad.dispatchEvent("lostpointercapture", eventFor(7, 86, 98, { buttons: 0 }));
  await page.waitForFunction(() => document.querySelector("#eventCount")?.textContent === "5");
  await page.locator("#stationaryTestButton").click();

  await pad.dispatchEvent("pointerdown", eventFor(8, 100, 120, { buttons: 1 }));
  await pad.dispatchEvent("pointercancel", eventFor(8, 100, 120, { buttons: 0 }));
  await pad.dispatchEvent("pointerdown", eventFor(9, 140, 150, { buttons: 1 }));
  await pad.dispatchEvent("lostpointercapture", eventFor(9, 140, 150, { buttons: 0 }));
  await page.waitForFunction(() => document.querySelector("#eventCount")?.textContent === "9");

  const pointerSnapshot = await page.evaluate(() => window.HapticDiagnostics.buildSnapshot());
  assert.equal(pointerSnapshot.events.length, 9);
  nearlyEqual(pointerSnapshot.pointerSummary.maxDistanceFromStartPx, 10);
  nearlyEqual(pointerSnapshot.pointerSummary.stationaryDriftRadiusPx, 10);
  nearlyEqual(pointerSnapshot.pointerSummary.pointerMoveStepDistanceP95Px, 5);
  assert.equal(pointerSnapshot.pointerSummary.stationaryTest.status, "complete");
  assert.equal(pointerSnapshot.pointerSummary.stationaryTest.sampleCount, 3);
  assert.equal(pointerSnapshot.pointerSummary.pointerCancelCount, 1);
  assert.equal(pointerSnapshot.pointerSummary.lostPointerCaptureCount, 2);
  assert.equal(pointerSnapshot.pointerSummary.unexpectedLostPointerCaptureCount, 1);
  const expectedRelease = pointerSnapshot.events.find(event => event.type === "lostpointercapture" && event.pointerId === 7);
  const unexpectedRelease = pointerSnapshot.events.find(event => event.type === "lostpointercapture" && event.pointerId === 9);
  assert.equal(expectedRelease.afterPointerUp, true);
  assert.equal(expectedRelease.unexpectedLostPointerCapture, false);
  assert.equal(unexpectedRelease.unexpectedLostPointerCapture, true);

  await page.locator("#enumerateHidButton").click();
  await page.waitForFunction(() => document.querySelector("#hidStatus")?.textContent.includes("1 个已授权 HID"));

  const snapshot = await page.evaluate(() => window.HapticDiagnostics.buildSnapshot());
  assert.equal(snapshot.nonOutputDiagnostic, true);
  assert.equal(snapshot.hidEnumeration.devices.length, 1);
  assert.equal(snapshot.hidEnumeration.devices[0].vendorId, 0x674e);
  assert.equal(snapshot.hidEnumeration.devices[0].collections[0].outputReports[0].byteLength, 64);

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#exportButton").click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^ruyi-input-diagnostics-.*\.json$/);

  await page.locator("#clearEventsButton").click();
  await page.waitForFunction(() => document.querySelector("#eventCount")?.textContent === "0");
  const cleared = await page.evaluate(() => window.HapticDiagnostics.buildSnapshot());
  assert.equal(cleared.pointerSummary.maxDistanceFromStartPx, 0);
  assert.equal(cleared.pointerSummary.stationaryDriftRadiusPx, null);
  assert.equal(cleared.pointerSummary.pointerMoveStepDistanceP95Px, null);
  assert.equal(cleared.pointerSummary.pointerCancelCount, 0);
  assert.equal(cleared.pointerSummary.lostPointerCaptureCount, 0);
  assert.equal(cleared.pointerSummary.unexpectedLostPointerCaptureCount, 0);
  assert.equal(cleared.pointerSummary.stationaryTest.status, "not-started");

  assert.deepEqual(await page.evaluate(() => window.__diagnosticsCounters), {
    getDevices: 1,
    requestDevice: 0,
    open: 0,
    sendReport: 0
  });

  await browser.close();
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(JSON.stringify({
    status: "PASS",
    checks: 12,
    pointerEvents: snapshot.events.length,
    stationaryDriftRadiusPx: snapshot.pointerSummary.stationaryDriftRadiusPx,
    pointerMoveStepDistanceP95Px: snapshot.pointerSummary.pointerMoveStepDistanceP95Px,
    pointerCancelCount: snapshot.pointerSummary.pointerCancelCount,
    lostPointerCaptureCount: snapshot.pointerSummary.lostPointerCaptureCount,
    unexpectedLostPointerCaptureCount: snapshot.pointerSummary.unexpectedLostPointerCaptureCount,
    authorizedDevices: snapshot.hidEnumeration.devices.length,
    hidCalls: { getDevices: 1, requestDevice: 0, open: 0, sendReport: 0 }
  }));
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});