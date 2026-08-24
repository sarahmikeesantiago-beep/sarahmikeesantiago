const assert = require("node:assert/strict");
const { launchChromium } = require("./test-runtime.cjs");
const { buildSignalPayload } = require("../haptic-protocol.js");

const BASE_URL = process.env.WEBHID_TEST_URL || "http://127.0.0.1:4173";

async function installMockHid(page, options = {}) {
  await page.addInitScript(({ authorized }) => {
    const listeners = new Map();
    const mock = {
      calls: [],
      filters: null,
      failNext: false,
      device: null,
      authorized,
      getDevicesCount: 0,
      requestDeviceCount: 0,
      openCount: 0
    };
    const device = {
      vendorId: 0x674e,
      productId: 0x0003,
      productName: "Mock Haptic Device",
      opened: false,
      collections: [{
        outputReports: [],
        children: [{
          outputReports: [{
            reportId: 0,
            items: [{ reportSize: 8, reportCount: 64 }]
          }],
          children: []
        }]
      }],
      async open() {
        mock.openCount += 1;
        this.opened = true;
      },
      async close() {
        this.opened = false;
      },
      async sendReport(reportId, data) {
        mock.calls.push({ reportId, bytes: Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)), time: performance.now() });
        if (mock.failNext) {
          mock.failNext = false;
          throw new Error("mock write failure");
        }
      }
    };
    mock.device = device;
    const hid = {
      addEventListener(name, listener) {
        listeners.set(name, listener);
      },
      async getDevices() {
        mock.getDevicesCount += 1;
        return mock.authorized ? [device] : [];
      },
      async requestDevice(options) {
        mock.requestDeviceCount += 1;
        mock.filters = options.filters;
        return [device];
      }
    };
    Object.defineProperty(navigator, "hid", { configurable: true, value: hid });
    Object.defineProperty(window, "__mockHid", { configurable: true, value: mock });
  }, { authorized: Boolean(options.authorized) });
}

async function waitForStop(page) {
  await page.waitForFunction(() => window.__mockHid.calls.some(call => call.bytes[0] === 0x83));
  await page.waitForTimeout(20);
}

async function resetCalls(page) {
  await page.evaluate(() => { window.__mockHid.calls.length = 0; });
}

async function readCalls(page) {
  return page.evaluate(() => window.__mockHid.calls.map(call => ({ reportId: call.reportId, bytes: [...call.bytes], time: call.time })));
}

function readFrequency(call) {
  return call.bytes[3] | (call.bytes[4] << 8);
}

function assertClose(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-9, label + ": expected " + expected + ", received " + actual);
}

const MATERIAL_TITLES = ["旋钮纹理再现", "凸起纹理再现", "化石纹理再现", "橡胶纹理再现"];

async function stableBoundingBox(page, locator, timeoutMs = 3000) {
  const started = Date.now();
  let previous = null;
  let stableSamples = 0;
  while (Date.now() - started < timeoutMs) {
    const box = await locator.boundingBox();
    if (box) {
      const stable = previous
        && Math.abs(box.x - previous.x) < 0.5
        && Math.abs(box.y - previous.y) < 0.5
        && Math.abs(box.width - previous.width) < 0.5
        && Math.abs(box.height - previous.height) < 0.5;
      stableSamples = stable ? stableSamples + 1 : 0;
      if (stableSamples >= 2) return box;
      previous = box;
    }
    await page.waitForTimeout(80);
  }
  throw new Error("Timed out waiting for a stable interaction surface");
}

async function waitForMaterial(page, index) {
  await page.waitForFunction(({ materialIndex, title }) => {
    const rail = document.querySelector('.rail-item[data-index="' + materialIndex + '"]');
    const image = document.querySelector("#demoImage");
    return rail?.hasAttribute("aria-current")
      && document.querySelector("#chapterTitle")?.textContent === title
      && image?.complete
      && image.naturalWidth > 0
      && !image.classList.contains("is-swapping");
  }, { materialIndex: index, title: MATERIAL_TITLES[index] });
  return stableBoundingBox(page, page.locator("#demoImage"));
}

async function assertImageCoordinateMapping(page) {
  const result = await page.evaluate(() => {
    const squareBox = { left: 0, top: 0, width: 300, height: 200 };
    const wideBox = { left: 0, top: 0, width: 300, height: 200 };
    return {
      squareTop: mapCoverPoint(150, 0, squareBox, 400, 400),
      squareBottom: mapCoverPoint(150, 200, squareBox, 400, 400),
      wideLeft: mapCoverPoint(0, 100, wideBox, 600, 200),
      wideRight: mapCoverPoint(300, 100, wideBox, 600, 200),
      fossilTop: fossilPixelPoint(0.5, 0.2, 1000, 1000),
      fossilBottom: fossilPixelPoint(0.5, 0.8, 1000, 1000)
    };
  });
  assertClose(result.squareTop.nx, 0.5, "square top x");
  assertClose(result.squareTop.ny, 1 / 6, "square top crop");
  assertClose(result.squareBottom.ny, 5 / 6, "square bottom crop");
  assertClose(result.wideLeft.nx, 0.25, "wide left crop");
  assertClose(result.wideRight.nx, 0.75, "wide right crop");
  assert.ok(result.squareTop.ny < result.squareBottom.ny, "Image Y must increase from top to bottom");
  assert.ok(result.fossilTop.y < result.fossilBottom.y, "Fossil sampling must not mirror Y");
}

async function dispatchTouch(page, type, pointerId, isPrimary, x, y) {
  await page.locator("#interactionSurface").dispatchEvent(type, {
    pointerId,
    pointerType: "touch",
    isPrimary,
    button: 0,
    buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
    clientX: x,
    clientY: y,
    bubbles: true
  });
}
function assertSignalAndStop(calls, expectedPayload) {
  const signal = calls.find(call => call.bytes[0] === 0x80);
  assert.ok(signal, "Expected a waveform signal");
  assert.equal(signal.reportId, 0);
  assert.equal(signal.bytes.length, 64);
  assert.deepEqual(signal.bytes, Array.from(expectedPayload));
  assert.equal(calls.at(-1).bytes[0], 0x83, "STOP must be the final report");
  assert.equal(calls.at(-1).bytes.length, 64);
}

async function exerciseSurface(page, index, expectedFrequency, shape) {
  await page.locator('.rail-item[data-index="' + index + '"]').click();
  const imageBox = await waitForMaterial(page, index);
  await resetCalls(page);
  await page.mouse.move(imageBox.x + imageBox.width * 0.48, imageBox.y + imageBox.height * 0.52);
  await page.mouse.down();
  await page.mouse.move(imageBox.x + imageBox.width * 0.55, imageBox.y + imageBox.height * 0.52, { steps: 3 });
  await page.mouse.up();
  await waitForStop(page);
  const calls = await readCalls(page);
  const signal = calls.find(call => call.bytes[0] === 0x80);
  assert.ok(signal, `Surface ${index} did not emit a signal`);
  const actualFrequency = readFrequency(signal);
  if (typeof expectedFrequency === "function") assert.ok(expectedFrequency(actualFrequency), `Unexpected surface frequency: ${actualFrequency}`);
  else assert.equal(actualFrequency, expectedFrequency);
  assertSignalAndStop(calls, buildSignalPayload(0, actualFrequency, 121, 50, shape, 0.3));
  return calls;
}

async function runNormalFlow(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await installMockHid(page);
  await page.goto(`${BASE_URL}/#knob`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#protocolBadge")?.textContent.includes("4/4"));
  await assertImageCoordinateMapping(page);

  assert.equal(await page.locator("#outputButton").isDisabled(), true);
  await page.locator("#deviceButton").click();
  await page.waitForFunction(() => !document.querySelector("#outputButton").disabled);
  const filters = await page.evaluate(() => window.__mockHid.filters);
  assert.deepEqual(filters, [{ vendorId: 0x674e, productId: 0x0003 }]);

  await page.locator("#outputButton").click();
  await page.waitForFunction(() => document.querySelector("#outputButton").getAttribute("aria-pressed") === "true");
  const enableCalls = await readCalls(page);
  assert.deepEqual(enableCalls.map(call => call.bytes[0]), [0x83]);

  const box = await page.locator("#mediaShell").boundingBox();
  if (!box) throw new Error("Knob stage is missing");
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const radius = Math.min(box.width, box.height) * 0.31;
  await resetCalls(page);
  await page.mouse.move(centerX + radius, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX, centerY + radius, { steps: 8 });
  await page.mouse.move(centerX - radius, centerY, { steps: 8 });
  await page.mouse.up();
  await waitForStop(page);
  const knobCalls = await readCalls(page);
  const knobSignal = knobCalls.find(call => call.bytes[0] === 0x80);
  assert.ok(knobSignal, "Knob did not emit a signal");
  const knobFrequency = readFrequency(knobSignal);
  assert.ok(knobFrequency >= 16 && knobFrequency <= 96);
  assertSignalAndStop(knobCalls, buildSignalPayload(0, knobFrequency, 135, 50, "方波", 0.5));

  await exerciseSurface(page, 1, 20, "方波");
  await exerciseSurface(page, 2, value => value >= 7 && value <= 42 && value % 7 === 0, "方波");
  await exerciseSurface(page, 3, 60, "正弦波");

  await page.locator('.rail-item[data-index="1"]').click();
  const touchBox = await waitForMaterial(page, 1);
  const touchY = touchBox.y + touchBox.height * 0.5;
  const touchX1 = touchBox.x + touchBox.width * 0.42;
  const touchX2 = touchBox.x + touchBox.width * 0.58;
  await page.evaluate(() => {
    const surface = document.querySelector("#interactionSurface");
    surface.setPointerCapture = () => {};
    surface.hasPointerCapture = () => false;
  });

  await resetCalls(page);
  await dispatchTouch(page, "pointerdown", 11, true, touchX1, touchY);
  await page.waitForFunction(() => window.__mockHid.calls.some(call => call.bytes[0] === 0x80));
  await dispatchTouch(page, "pointerdown", 12, false, touchX2, touchY);
  await dispatchTouch(page, "pointerup", 11, true, touchX1, touchY);
  await page.waitForTimeout(80);
  const multiPointerCalls = await readCalls(page);
  assert.equal(multiPointerCalls.filter(call => call.bytes[0] === 0x80).length, 1, "Secondary touch must not emit a second waveform");
  assert.ok(multiPointerCalls.some(call => call.bytes[0] === 0x83), "Primary pointer release must emit STOP within 80 ms");
  await dispatchTouch(page, "pointerup", 12, false, touchX2, touchY);
  await page.waitForTimeout(20);
  const callsAfterSecondaryUp = await readCalls(page);
  assert.equal(callsAfterSecondaryUp.filter(call => call.bytes[0] === 0x80).length, 1, "Secondary pointer release must not emit a waveform");

  await resetCalls(page);
  await dispatchTouch(page, "pointerdown", 21, true, touchX1, touchY);
  await page.waitForFunction(() => window.__mockHid.calls.some(call => call.bytes[0] === 0x80));
  const navigationStarted = await page.evaluate(() => {
    window.__mockHid.calls.length = 0;
    const started = performance.now();
    document.querySelector('.rail-item[data-index="0"]').click();
    return started;
  });
  await page.waitForTimeout(80);
  const navigationCalls = await readCalls(page);
  const navigationStop = navigationCalls.find(call => call.bytes[0] === 0x83);
  assert.ok(navigationStop, "Navigation must emit STOP without waiting for smooth scrolling");
  const navigationDelay = navigationStop.time - navigationStarted;
  assert.ok(navigationDelay < 80, "Navigation STOP was delayed by " + navigationDelay + " ms");

  await resetCalls(page);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await waitForStop(page);
  assert.equal((await readCalls(page)).at(-1).bytes[0], 0x83);

  await resetCalls(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    delete document.hidden;
  });
  await waitForStop(page);
  assert.equal((await readCalls(page)).at(-1).bytes[0], 0x83);

  await resetCalls(page);
  await page.locator('.rail-item[data-index="0"]').click();
  await waitForStop(page);
  assert.equal((await readCalls(page)).at(-1).bytes[0], 0x83);

  await page.locator('.rail-item[data-index="1"]').click();
  const bumpBox = await waitForMaterial(page, 1);
  await resetCalls(page);
  await page.mouse.move(bumpBox.x + bumpBox.width / 2, bumpBox.y + bumpBox.height / 2);
  await page.mouse.down();
  await page.evaluate(() => {
    document.querySelector("#interactionSurface").dispatchEvent(new PointerEvent("pointercancel", {
      bubbles: true,
      pointerId: 1,
      pointerType: "mouse"
    }));
  });
  await waitForStop(page);
  await page.mouse.up();
  assert.equal((await readCalls(page)).at(-1).bytes[0], 0x83);

  await resetCalls(page);
  await page.evaluate(() => { window.__mockHid.failNext = true; });
  await page.mouse.move(bumpBox.x + bumpBox.width / 2, bumpBox.y + bumpBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(bumpBox.x + bumpBox.width * 0.55, bumpBox.y + bumpBox.height / 2, { steps: 2 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector("#outputButton").disabled);
  assert.equal(await page.evaluate(() => window.__mockHid.device.opened), false);

  await page.close();
  if (errors.length) throw new Error(errors.join("\n"));
  return { knobFrequency };
}

async function runAuthorizedRestoreAndNarrowLayout(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await installMockHid(page, { authorized: true });
  await page.goto(BASE_URL + "/#knob", { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#deviceButtonText")?.textContent === "断开触觉设备");

  const state = await page.evaluate(() => ({
    calls: window.__mockHid.calls.length,
    getDevicesCount: window.__mockHid.getDevicesCount,
    requestDeviceCount: window.__mockHid.requestDeviceCount,
    openCount: window.__mockHid.openCount,
    outputDisabled: document.querySelector("#outputButton").disabled,
    outputPressed: document.querySelector("#outputButton").getAttribute("aria-pressed"),
    outputDisplay: getComputedStyle(document.querySelector("#outputButton")).display,
    outputRect: document.querySelector("#outputButton").getBoundingClientRect().toJSON(),
    viewportWidth: innerWidth
  }));

  assert.equal(state.getDevicesCount, 1);
  assert.equal(state.requestDeviceCount, 0);
  assert.equal(state.openCount, 1);
  assert.equal(state.calls, 0);
  assert.equal(state.outputDisabled, false);
  assert.equal(state.outputPressed, "false");
  assert.notEqual(state.outputDisplay, "none");
  assert.ok(state.outputRect.width > 0 && state.outputRect.right <= state.viewportWidth, "Narrow output button must remain inside the viewport");

  const stageBox = await page.locator("#mediaShell").boundingBox();
  if (!stageBox) throw new Error("Authorized restore stage is missing");
  await page.mouse.move(stageBox.x + stageBox.width * 0.7, stageBox.y + stageBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + stageBox.width * 0.5, stageBox.y + stageBox.height * 0.7, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__mockHid.calls.length), 0, "Restored connection must not send while output remains disabled");

  for (const width of [320, 390, 520, 521, 840]) {
    await page.setViewportSize({ width, height: 844 });
    const layout = await page.evaluate(() => {
      const output = document.querySelector("#outputButton").getBoundingClientRect();
      const brand = document.querySelector(".brand").getBoundingClientRect();
      const actions = document.querySelector(".topbar-actions").getBoundingClientRect();
      return {
        display: getComputedStyle(document.querySelector("#outputButton")).display,
        output: output.toJSON(),
        brand: brand.toJSON(),
        actions: actions.toJSON(),
        viewportWidth: innerWidth
      };
    });
    assert.notEqual(layout.display, "none");
    assert.ok(layout.output.width > 0 && layout.output.x >= 0 && layout.output.right <= layout.viewportWidth, "Output button overflow at width " + width);
    assert.ok(layout.brand.right <= layout.actions.left + 1, "Topbar controls overlap at width " + width);
  }

  if (errors.length) throw new Error(errors.join("\n"));
  await page.close();
}

async function runFailedProtocolGate(browser) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  await installMockHid(page);
  await page.route("**/haptic-protocol.js", async route => {
    const response = await route.fetch();
    const original = await response.text();
    await route.fulfill({
      response,
      body: `${original}\nHapticProtocol.selfTest = async () => ({ passed: 0, total: 1, results: [{ name: "forced", passed: false }] });`
    });
  });
  await page.goto(`${BASE_URL}/#knob`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#protocolBadge")?.textContent === "协议自检失败");
  assert.deepEqual(await page.evaluate(() => ({
    getDevicesCount: window.__mockHid.getDevicesCount,
    requestDeviceCount: window.__mockHid.requestDeviceCount,
    openCount: window.__mockHid.openCount
  })), { getDevicesCount: 0, requestDeviceCount: 0, openCount: 0 });
  await page.locator("#deviceButton").click();
  await page.waitForFunction(() => document.querySelector("#deviceButtonText")?.textContent === "断开触觉设备");
  assert.equal(await page.locator("#outputButton").isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__mockHid.calls.length), 0);
  await page.close();
}

async function run() {
  const browser = await launchChromium();
  try {
    const normal = await runNormalFlow(browser);
    await runAuthorizedRestoreAndNarrowLayout(browser);
    await runFailedProtocolGate(browser);
    console.log(JSON.stringify({ status: "PASS", knobFrequency: normal.knobFrequency, browserChecks: 17 }));
  } finally {
    await browser.close();
  }
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
