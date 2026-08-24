(function exposeHapticTransport(globalObject) {
  "use strict";

  const TARGET_HID = Object.freeze({
    vendorId: 0x674e,
    productId: 0x0003,
    payloadLength: 64
  });
  const DEFAULT_WATCHDOG_MS = 350;
  const DEFAULT_REPORT_TIMEOUT_MS = 350;

  function asPositiveInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
  }

  function outputReportByteLength(report) {
    const bitLength = (report?.items || []).reduce((total, item) => {
      return total + asPositiveInteger(item.reportSize) * asPositiveInteger(item.reportCount);
    }, 0);
    return Math.ceil(bitLength / 8);
  }

  function collectOutputReports(collections, output = []) {
    for (const collection of collections || []) {
      for (const report of collection.outputReports || []) {
        output.push({
          reportId: Number(report.reportId) || 0,
          byteLength: outputReportByteLength(report),
          report
        });
      }
      collectOutputReports(collection.children || [], output);
    }
    return output;
  }

  function discoverOutputReport(device, payloadLength = TARGET_HID.payloadLength) {
    const matching = collectOutputReports(device?.collections).filter(report => report.byteLength === payloadLength);
    const unique = new Map();
    for (const report of matching) unique.set(`${report.reportId}:${report.byteLength}`, report);
    const candidates = Array.from(unique.values());
    if (!candidates.length) throw new Error(`设备没有${payloadLength}字节的触觉输出报告`);
    if (candidates.length !== 1) throw new Error(`设备存在多个${payloadLength}字节输出报告，无法安全确定报告ID`);
    return candidates[0];
  }

  function normalizedError(error, fallback) {
    if (error instanceof Error) return error;
    return new Error(String(error || fallback));
  }

  class WebHidTransport {
    constructor(options = {}) {
      this.hid = options.hid ?? globalObject.navigator?.hid ?? null;
      this.secureContext = options.secureContext ?? Boolean(globalObject.isSecureContext);
      this.vendorId = options.vendorId ?? TARGET_HID.vendorId;
      this.productId = options.productId ?? TARGET_HID.productId;
      this.payloadLength = options.payloadLength ?? TARGET_HID.payloadLength;
      this.watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
      this.reportTimeoutMs = options.reportTimeoutMs ?? DEFAULT_REPORT_TIMEOUT_MS;
      this.buildStopPayload = options.buildStopPayload ?? globalObject.HapticProtocol?.buildStopPayload;
      this.equalBytes = options.equalBytes ?? globalObject.HapticProtocol?.equalBytes;
      this.setTimer = options.setTimer ?? globalObject.setTimeout.bind(globalObject);
      this.clearTimer = options.clearTimer ?? globalObject.clearTimeout.bind(globalObject);

      this.device = null;
      this.reportId = 0;
      this.reportBytes = 0;
      this.outputEnabled = false;
      this.protocolReady = false;
      this.faulted = false;
      this.lastReport = null;
      this.state = "disconnected";
      this.stateLabel = "设备未连接";
      this.generation = 0;
      this.queue = Promise.resolve();
      this.pendingSignal = null;
      this.signalDrainPromise = null;
      this.stopBarrierCount = 0;
      this.watchdogTimer = null;
      this.onState = () => {};
      this.onError = () => {};
      this.onWatchdog = () => {};

      if (this.hid?.addEventListener) {
        this.hid.addEventListener("disconnect", event => {
          if (this.device && event.device === this.device) this.handlePhysicalDisconnect();
        });
      }
    }

    get supported() {
      return this.secureContext && Boolean(this.hid?.requestDevice);
    }

    setState(state, label) {
      this.state = state;
      this.stateLabel = label || "";
      this.onState(this.state, this.stateLabel);
    }

    setProtocolReady(ready) {
      const wasEnabled = this.outputEnabled;
      this.protocolReady = Boolean(ready);
      if (this.protocolReady) return;
      this.outputEnabled = false;
      this.clearWatchdog();
      this.generation += 1;
      this.clearPendingSignal();
      this.lastReport = null;
      if (wasEnabled && this.device?.opened) this.stop(true).catch(error => this.onError(normalizedError(error, "停止输出失败")));
    }

    handlePhysicalDisconnect() {
      this.clearWatchdog();
      this.generation += 1;
      this.clearPendingSignal();
      this.outputEnabled = false;
      this.lastReport = null;
      this.device = null;
      this.reportId = 0;
      this.reportBytes = 0;
      this.faulted = false;
      this.setState("disconnected", "设备已断开");
    }

    clearWatchdog() {
      if (this.watchdogTimer !== null) this.clearTimer(this.watchdogTimer);
      this.watchdogTimer = null;
    }

    refreshWatchdog() {
      this.clearWatchdog();
      if (!this.outputEnabled || !this.device?.opened || this.faulted) return;
      const generation = this.generation;
      this.watchdogTimer = this.setTimer(() => {
        this.watchdogTimer = null;
        if (!this.outputEnabled || !this.device?.opened || this.faulted || generation !== this.generation) return;
        this.onWatchdog();
        this.stop(true).catch(error => this.onError(normalizedError(error, "看门狗停止失败")));
      }, this.watchdogMs);
    }

    enqueue(operation) {
      const result = this.queue.then(operation, operation);
      this.queue = result.catch(() => {});
      return result;
    }

    clearPendingSignal() {
      const pending = this.pendingSignal;
      this.pendingSignal = null;
      if (pending) pending.resolve(false);
    }

    async performSignal(request) {
      const { device, force, generation, report, reportId } = request;
      if (generation !== this.generation || device !== this.device || !this.outputEnabled || this.faulted) return false;
      if (!force && this.lastReport && this.equalBytes?.(report, this.lastReport)) return true;
      try {
        await this.writeReport(device, reportId, report);
      } catch (error) {
        throw this.enterFault(error);
      }
      if (generation !== this.generation || device !== this.device || !this.outputEnabled || this.faulted) return false;
      this.lastReport = report;
      return true;
    }

    startSignalDrain() {
      if (this.signalDrainPromise || this.stopBarrierCount > 0 || !this.pendingSignal) return;
      const drain = this.enqueue(async () => {
        while (this.stopBarrierCount === 0 && this.pendingSignal) {
          const request = this.pendingSignal;
          this.pendingSignal = null;
          try {
            request.resolve(await this.performSignal(request));
          } catch (error) {
            request.reject(error);
            this.clearPendingSignal();
            throw error;
          }
        }
      });
      this.signalDrainPromise = drain;
      drain.catch(() => {}).finally(() => {
        if (this.signalDrainPromise === drain) this.signalDrainPromise = null;
        if (this.stopBarrierCount === 0 && this.pendingSignal) this.startSignalDrain();
      });
    }

    queueLatestSignal(request) {
      if (this.pendingSignal) this.pendingSignal.resolve(false);
      this.pendingSignal = request;
      this.startSignalDrain();
      return request.completion;
    }

    async writeReport(device, reportId, payload) {
      let timeoutId = null;
      const timeout = new Promise((_, reject) => {
        timeoutId = this.setTimer(() => reject(new Error(`HID写入超过${this.reportTimeoutMs}毫秒`)), this.reportTimeoutMs);
      });
      try {
        await Promise.race([
          Promise.resolve().then(() => device.sendReport(reportId, payload)),
          timeout
        ]);
      } finally {
        if (timeoutId !== null) this.clearTimer(timeoutId);
      }
    }

    enterFault(error) {
      const fault = normalizedError(error, "触觉设备通信失败");
      const device = this.device;
      this.clearWatchdog();
      this.generation += 1;
      this.clearPendingSignal();
      this.outputEnabled = false;
      this.faulted = true;
      this.lastReport = null;
      this.device = null;
      this.reportId = 0;
      this.reportBytes = 0;
      this.setState("error", fault.message);
      this.onError(fault);
      if (device?.opened) Promise.resolve(device.close()).catch(() => {});
      return fault;
    }

    compatibleDevices(devices) {
      const matches = [];
      for (const device of devices || []) {
        if (device.vendorId !== this.vendorId || device.productId !== this.productId) continue;
        try {
          matches.push({ device, outputReport: discoverOutputReport(device, this.payloadLength) });
        } catch (_) {}
      }
      return matches;
    }

    async attachCompatibleDevice(selected) {
      const openedDevice = selected.device;
      if (!openedDevice.opened) await openedDevice.open();
      if (openedDevice.vendorId !== this.vendorId || openedDevice.productId !== this.productId) {
        throw new Error("所选设备的VID/PID与触觉设备不一致");
      }
      const verifiedReport = discoverOutputReport(openedDevice, this.payloadLength);
      if (verifiedReport.reportId !== selected.outputReport.reportId) throw new Error("设备输出报告在连接后发生变化");

      this.clearWatchdog();
      this.generation += 1;
      this.clearPendingSignal();
      this.device = openedDevice;
      this.reportId = verifiedReport.reportId;
      this.reportBytes = verifiedReport.byteLength;
      this.outputEnabled = false;
      this.faulted = false;
      this.lastReport = null;
      this.setState("connected", openedDevice.productName || "触觉设备已连接");
      return openedDevice;
    }

    async connect() {
      if (!this.supported) throw new Error("当前环境不支持 WebHID，请使用桌面版 Chrome/Edge并通过localhost或HTTPS打开。");
      this.setState("connecting", "正在选择指定触觉设备");
      let openedDevice = null;
      try {
        const devices = await this.hid.requestDevice({
          filters: [{ vendorId: this.vendorId, productId: this.productId }]
        });
        const matches = this.compatibleDevices(devices);
        if (!matches.length) throw new Error("没有选择兼容的触觉设备，或设备缺少64字节输出报告");
        if (matches.length !== 1) throw new Error("检测到多个兼容的触觉接口，无法安全确定输出接口");

        const selected = matches[0];
        openedDevice = selected.device;
        return await this.attachCompatibleDevice(selected);
      } catch (error) {
        if (openedDevice?.opened) {
          try { await openedDevice.close(); } catch (_) {}
        }
        this.device = null;
        this.outputEnabled = false;
        this.reportId = 0;
        this.reportBytes = 0;
        this.setState("error", normalizedError(error, "连接触觉设备失败").message);
        throw error;
      }
    }

    async restoreAuthorizedDevice() {
      if (!this.secureContext || typeof this.hid?.getDevices !== "function") return false;
      if (this.device?.opened && !this.faulted) return true;
      this.setState("connecting", "正在检查已授权触觉设备");
      let openedDevice = null;
      try {
        const matches = this.compatibleDevices(await this.hid.getDevices());
        if (!matches.length) {
          this.setState("disconnected", "未发现已授权触觉设备");
          return false;
        }
        if (matches.length !== 1) {
          this.setState("disconnected", "检测到多个已授权触觉接口，请手动连接");
          return false;
        }
        openedDevice = matches[0].device;
        await this.attachCompatibleDevice(matches[0]);
        return true;
      } catch (error) {
        if (openedDevice?.opened) {
          try { await openedDevice.close(); } catch (_) {}
        }
        this.clearPendingSignal();
        this.device = null;
        this.outputEnabled = false;
        this.reportId = 0;
        this.reportBytes = 0;
        this.setState("error", normalizedError(error, "恢复已授权触觉设备失败").message);
        throw error;
      }
    }

    async enableOutput() {
      if (!this.protocolReady) throw new Error("触觉协议自检尚未通过");
      if (this.faulted) throw new Error("触觉设备处于故障锁定状态，请重新连接");
      if (!this.device?.opened || this.reportBytes !== this.payloadLength) throw new Error("触觉设备尚未正确连接");
      await this.stop(true);
      if (!this.device?.opened || this.faulted) throw new Error("触觉设备无法进入安全输出状态");
      this.outputEnabled = true;
      return true;
    }

    async disableOutput() {
      this.outputEnabled = false;
      this.clearWatchdog();
      if (!this.device?.opened) return false;
      return this.stop(true);
    }

    async sendPayload(payload, force = false) {
      if (!(payload instanceof Uint8Array) || payload.length !== this.payloadLength) {
        throw new Error(`触觉有效载荷必须为${this.payloadLength}字节`);
      }
      if (!this.outputEnabled) return false;
      if (!this.protocolReady) throw new Error("触觉协议自检尚未通过");
      if (this.faulted || !this.device?.opened) throw new Error("触觉设备不可用");

      const report = payload.slice();
      const generation = this.generation;
      const device = this.device;
      const reportId = this.reportId;
      this.refreshWatchdog();
      let resolveCompletion;
      let rejectCompletion;
      const completion = new Promise((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      return this.queueLatestSignal({
        completion,
        device,
        force,
        generation,
        reject: rejectCompletion,
        report,
        reportId,
        resolve: resolveCompletion
      });
    }

    async stop(force = false) {
      this.clearWatchdog();
      const wasEnabled = this.outputEnabled;
      if (!force && !wasEnabled) return false;
      const device = this.device;
      if (!device?.opened) return false;
      const reportId = this.reportId;
      const stopPayload = this.buildStopPayload();
      if (!(stopPayload instanceof Uint8Array) || stopPayload.length !== this.payloadLength || stopPayload[0] !== 0x83) {
        throw this.enterFault(new Error("停止有效载荷无效"));
      }

      this.generation += 1;
      this.clearPendingSignal();
      this.stopBarrierCount += 1;
      const stopTask = this.enqueue(async () => {
        if (device !== this.device || !device.opened || this.faulted) return false;
        try {
          await this.writeReport(device, reportId, stopPayload);
        } catch (error) {
          throw this.enterFault(error);
        }
        this.lastReport = null;
        return true;
      });
      return stopTask.finally(() => {
        this.stopBarrierCount = Math.max(0, this.stopBarrierCount - 1);
        if (this.stopBarrierCount === 0 && this.pendingSignal) this.startSignalDrain();
      });
    }

    async disconnect() {
      const device = this.device;
      this.outputEnabled = false;
      this.clearWatchdog();
      let failure = null;
      if (device?.opened) {
        try { await this.stop(true); } catch (error) { failure = normalizedError(error, "停止输出失败"); }
        try { await device.close(); } catch (error) { failure ||= normalizedError(error, "关闭设备失败"); }
      }
      this.generation += 1;
      this.clearPendingSignal();
      this.device = null;
      this.reportId = 0;
      this.reportBytes = 0;
      this.outputEnabled = false;
      this.lastReport = null;
      this.faulted = Boolean(failure);
      this.setState(failure ? "error" : "disconnected", failure?.message || "设备已断开");
      if (failure) throw failure;
      return true;
    }
  }

  const api = {
    DEFAULT_REPORT_TIMEOUT_MS,
    DEFAULT_WATCHDOG_MS,
    TARGET_HID,
    WebHidTransport,
    collectOutputReports,
    discoverOutputReport,
    outputReportByteLength
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalObject.HapticTransport = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
