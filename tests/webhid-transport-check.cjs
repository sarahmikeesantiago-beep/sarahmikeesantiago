const assert = require("node:assert/strict");
const {
  buildSignalPayload,
  buildStopPayload,
  equalBytes,
  selfTest
} = require("../haptic-protocol.js");
const {
  DEFAULT_WATCHDOG_MS,
  TARGET_HID,
  WebHidTransport,
  discoverOutputReport
} = require("../webhid-transport.js");

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate, timeoutMs = 500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for test condition");
    await delay(2);
  }
}

function createDevice(options = {}) {
  const payloadBytes = options.payloadBytes ?? 64;
  const outputReport = {
    reportId: options.reportId ?? 0,
    items: [{ reportSize: 8, reportCount: payloadBytes }]
  };
  const reportCollection = { outputReports: [outputReport], children: [] };
  const collections = options.nested === false
    ? [reportCollection]
    : [{ outputReports: [], children: [reportCollection] }];

  const device = {
    vendorId: options.vendorId ?? TARGET_HID.vendorId,
    productId: options.productId ?? TARGET_HID.productId,
    productName: options.productName ?? "Mock Haptic Device",
    collections,
    opened: false,
    calls: [],
    closeCount: 0,
    holdNext: null,
    rejectNext: null,
    async open() {
      this.opened = true;
    },
    async close() {
      this.closeCount += 1;
      this.opened = false;
    },
    async sendReport(reportId, data) {
      this.calls.push({ reportId, bytes: Uint8Array.from(data) });
      if (this.rejectNext) {
        const error = this.rejectNext;
        this.rejectNext = null;
        throw error;
      }
      if (this.holdNext) {
        const pending = this.holdNext;
        this.holdNext = null;
        await pending;
      }
    }
  };
  return device;
}

function createHid(devices, authorizedDevices = []) {
  return {
    requestOptions: null,
    getDevicesCount: 0,
    listeners: new Map(),
    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    },
    async getDevices() {
      this.getDevicesCount += 1;
      return authorizedDevices;
    },
    async requestDevice(options) {
      this.requestOptions = options;
      return devices;
    }
  };
}

function createTransport(hid, options = {}) {
  return new WebHidTransport({
    hid,
    secureContext: true,
    buildStopPayload,
    equalBytes,
    watchdogMs: options.watchdogMs ?? 1000,
    reportTimeoutMs: options.reportTimeoutMs ?? 100
  });
}

function command(call) {
  return call?.bytes?.[0];
}

function frequency(call) {
  return call.bytes[3] | (call.bytes[4] << 8);
}

async function testConnectionAndSignals() {
  const device = createDevice({ nested: true, reportId: 0 });
  const hid = createHid([device]);
  const transport = createTransport(hid);
  transport.setProtocolReady(true);
  await transport.connect();

  assert.deepEqual(hid.requestOptions, {
    filters: [{ vendorId: 0x674e, productId: 0x0003 }]
  });
  assert.equal(transport.reportId, 0);
  assert.equal(transport.reportBytes, 64);
  assert.equal(transport.outputEnabled, false);

  await transport.enableOutput();
  const materialPayloads = [
    buildSignalPayload(0, 96, 135, 50, "方波", 0.5),
    buildSignalPayload(0, 20, 121, 50, "方波", 0.3),
    buildSignalPayload(0, 28, 121, 50, "方波", 0.3),
    buildSignalPayload(0, 60, 121, 50, "正弦波", 0.3)
  ];
  for (const payload of materialPayloads) await transport.sendPayload(payload, true);
  await transport.stop(true);

  assert.deepEqual(device.calls.map(command), [0x83, 0x80, 0x80, 0x80, 0x80, 0x83]);
  assert.deepEqual(device.calls.slice(1, 5).map(frequency), [96, 20, 28, 60]);
  for (const call of device.calls) {
    assert.equal(call.reportId, 0);
    assert.equal(call.bytes.length, 64);
  }
}

async function testAuthorizedDeviceRestore() {
  const device = createDevice({ productName: "Previously Authorized Device" });
  const hid = createHid([], [device]);
  const transport = createTransport(hid);
  transport.setProtocolReady(true);

  const restored = await transport.restoreAuthorizedDevice();

  assert.equal(restored, true);
  assert.equal(hid.getDevicesCount, 1);
  assert.equal(hid.requestOptions, null);
  assert.equal(device.opened, true);
  assert.equal(transport.state, "connected");
  assert.equal(transport.outputEnabled, false);
  assert.equal(device.calls.length, 0);

  const emptyHid = createHid([], []);
  const emptyTransport = createTransport(emptyHid);
  emptyTransport.setProtocolReady(true);
  assert.equal(await emptyTransport.restoreAuthorizedDevice(), false);
  assert.equal(emptyTransport.state, "disconnected");
  assert.equal(emptyHid.requestOptions, null);
}

async function testDeviceAndDescriptorRejection() {
  const wrongDevice = createDevice({ vendorId: 0x1234 });
  const wrongTransport = createTransport(createHid([wrongDevice]));
  wrongTransport.setProtocolReady(true);
  await assert.rejects(() => wrongTransport.connect(), /没有选择兼容/);
  assert.equal(wrongDevice.opened, false);

  const shortDevice = createDevice({ payloadBytes: 63 });
  const shortTransport = createTransport(createHid([shortDevice]));
  shortTransport.setProtocolReady(true);
  await assert.rejects(() => shortTransport.connect(), /缺少64字节/);
  assert.equal(shortDevice.opened, false);

  assert.throws(() => discoverOutputReport(shortDevice), /没有64字节/);
}

async function testProtocolGateAndPayloadLength() {
  const device = createDevice();
  const transport = createTransport(createHid([device]));
  await transport.connect();
  await assert.rejects(() => transport.enableOutput(), /自检尚未通过/);
  await assert.rejects(() => transport.sendPayload(new Uint8Array(63)), /必须为64字节/);
  await assert.rejects(() => transport.sendPayload(new Uint8Array(65)), /必须为64字节/);
  assert.equal(device.calls.length, 0);
}

async function testLatestPayloadOverwritesPending() {
  const device = createDevice();
  const transport = createTransport(createHid([device]));
  transport.setProtocolReady(true);
  await transport.connect();
  await transport.enableOutput();
  device.calls.length = 0;

  const gate = deferred();
  device.holdNext = gate.promise;
  const first = transport.sendPayload(buildSignalPayload(0, 32, 135, 50, "方波", 0.5), true);
  await waitFor(() => device.calls.length === 1);
  const superseded = transport.sendPayload(buildSignalPayload(0, 48, 135, 50, "方波", 0.5), true);
  const latest = transport.sendPayload(buildSignalPayload(0, 64, 135, 50, "方波", 0.5), true);

  assert.equal(await superseded, false);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, latest]), [true, true]);
  assert.deepEqual(device.calls.map(frequency), [32, 64]);
}

async function testPhysicalDisconnectSettlesSignalsFalse() {
  const device = createDevice();
  const transport = createTransport(createHid([device]));
  const errors = [];
  transport.onError = error => errors.push(error.message);
  transport.setProtocolReady(true);
  await transport.connect();
  await transport.enableOutput();
  device.calls.length = 0;

  const gate = deferred();
  device.holdNext = gate.promise;
  const inFlight = transport.sendPayload(buildSignalPayload(0, 32, 135, 50, "方波", 0.5), true);
  await waitFor(() => device.calls.length === 1);
  const pending = transport.sendPayload(buildSignalPayload(0, 48, 135, 50, "方波", 0.5), true);
  transport.handlePhysicalDisconnect();
  gate.reject(new Error("NetworkError: device disconnected"));

  assert.deepEqual(await Promise.all([inFlight, pending]), [false, false]);
  assert.deepEqual(device.calls.map(command), [0x80]);
  assert.equal(transport.state, "disconnected");
  assert.equal(transport.outputEnabled, false);
  assert.equal(transport.faulted, false);
  assert.equal(transport.device, null);
  assert.equal(errors.length, 0);
}

async function testPhysicalDisconnectSettlesStopFalse() {
  const device = createDevice();
  const transport = createTransport(createHid([device]));
  const errors = [];
  transport.onError = error => errors.push(error.message);
  transport.setProtocolReady(true);
  await transport.connect();
  await transport.enableOutput();
  device.calls.length = 0;

  const gate = deferred();
  device.holdNext = gate.promise;
  const stopping = transport.stop(true);
  await waitFor(() => device.calls.length === 1);
  transport.handlePhysicalDisconnect();
  gate.reject(new Error("NetworkError: device disconnected"));

  assert.equal(await stopping, false);
  assert.deepEqual(device.calls.map(command), [0x83]);
  assert.equal(transport.state, "disconnected");
  assert.equal(transport.outputEnabled, false);
  assert.equal(transport.faulted, false);
  assert.equal(transport.device, null);
  assert.equal(errors.length, 0);
}

async function testConcurrentStopsStayAheadOfSignals() {
  const device = createDevice();
  const transport = createTransport(createHid([device]));
  transport.setProtocolReady(true);
  await transport.connect();
  await transport.enableOutput();
  device.calls.length = 0;

  const gate = deferred();
  device.holdNext = gate.promise;
  const inFlight = transport.sendPayload(buildSignalPayload(0, 32, 135, 50, "方波", 0.5), true);
  await waitFor(() => device.calls.length === 1);
  const firstStop = transport.stop(true);
  const betweenStops = transport.sendPayload(buildSignalPayload(0, 48, 135, 50, "方波", 0.5), true);
  const secondStop = transport.stop(true);
  gate.resolve();

  const results = await Promise.all([inFlight, firstStop, betweenStops, secondStop]);
  assert.deepEqual(results, [false, true, false, true]);
  assert.deepEqual(device.calls.map(command), [0x80, 0x83, 0x83]);
}

async function testStopBarrierDropsQueuedSignals() {
  const device = createDevice();
  const transport = createTransport(createHid([device]));
  transport.setProtocolReady(true);
  await transport.connect();
  await transport.enableOutput();
  device.calls.length = 0;

  const gate = deferred();
  device.holdNext = gate.promise;
  const first = transport.sendPayload(buildSignalPayload(0, 32, 135, 50, "方波", 0.5), true);
  await waitFor(() => device.calls.length === 1);
  const stale = transport.sendPayload(buildSignalPayload(0, 48, 135, 50, "方波", 0.5), true);
  const stopped = transport.stop(true);
  gate.resolve();
  const [, staleResult] = await Promise.all([first, stale, stopped]);

  assert.equal(staleResult, false);
  assert.deepEqual(device.calls.map(command), [0x80, 0x83]);
  assert.equal(frequency(device.calls[0]), 32);
}

async function testWatchdogStop() {
  const device = createDevice();
  const transport = createTransport(createHid([device]), { watchdogMs: 25, reportTimeoutMs: 100 });
  let watchdogCount = 0;
  transport.onWatchdog = () => { watchdogCount += 1; };
  transport.setProtocolReady(true);
  await transport.connect();
  await transport.enableOutput();
  device.calls.length = 0;
  await transport.sendPayload(buildSignalPayload(0, 20, 121, 50, "方波", 0.3), true);
  await waitFor(() => device.calls.some(call => command(call) === 0x83), 250);

  assert.equal(watchdogCount, 1);
  assert.deepEqual(device.calls.map(command), [0x80, 0x83]);
  assert.equal(DEFAULT_WATCHDOG_MS, 350);
}

async function testWriteTimeoutFailsClosed() {
  const device = createDevice();
  const transport = createTransport(createHid([device]), { watchdogMs: 1000, reportTimeoutMs: 20 });
  const errors = [];
  transport.onError = error => errors.push(error.message);
  transport.setProtocolReady(true);
  await transport.connect();
  await transport.enableOutput();
  device.calls.length = 0;
  device.holdNext = new Promise(() => {});

  await assert.rejects(
    () => transport.sendPayload(buildSignalPayload(0, 20, 121, 50, "方波", 0.3), true),
    /超过20毫秒/
  );
  await delay(5);
  assert.equal(transport.outputEnabled, false);
  assert.equal(transport.faulted, true);
  assert.equal(transport.state, "error");
  assert.equal(transport.device, null);
  assert.ok(device.closeCount >= 1);
  assert.equal(errors.length, 1);
}

async function run() {
  const protocol = await selfTest();
  assert.equal(protocol.passed, protocol.total);
  assert.equal(TARGET_HID.vendorId, 0x674e);
  assert.equal(TARGET_HID.productId, 0x0003);
  assert.equal(TARGET_HID.payloadLength, 64);

  await testConnectionAndSignals();
  await testAuthorizedDeviceRestore();
  await testDeviceAndDescriptorRejection();
  await testProtocolGateAndPayloadLength();
  await testLatestPayloadOverwritesPending();
  await testPhysicalDisconnectSettlesSignalsFalse();
  await testPhysicalDisconnectSettlesStopFalse();
  await testConcurrentStopsStayAheadOfSignals();
  await testStopBarrierDropsQueuedSignals();
  await testWatchdogStop();
  await testWriteTimeoutFailsClosed();

  console.log(JSON.stringify({
    status: "PASS",
    protocol: `${protocol.passed}/${protocol.total}`,
    target: "VID_674E/PID_0003",
    payloadBytes: 64,
    watchdogMs: DEFAULT_WATCHDOG_MS,
    checks: 11
  }));
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
