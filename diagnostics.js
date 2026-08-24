"use strict";

(function initializeDiagnostics() {
  const MAX_EVENTS = 500;
  const MAX_TABLE_ROWS = 80;
  const BUILD_REVISION = "ruyi-web-v1.1.1";
  const DIAGNOSTICS_SCHEMA_VERSION = "ruyi-input-diagnostics-v2";
  const events = [];
  const pointerState = new Map();
  const pointerEndReason = new Map();
  let renderScheduled = false;
  let toastTimer = 0;
  let maxDistanceFromStart = 0;
  let pointerCancelCount = 0;
  let lostPointerCaptureCount = 0;
  let unexpectedLostPointerCaptureCount = 0;
  let stationaryTest = createStationaryTestState();
  let hidEnumeration = {
    status: "not-run",
    checkedAt: null,
    durationMs: null,
    error: null,
    devices: []
  };

  const elements = {
    environmentGrid: document.getElementById("environmentGrid"),
    environmentTimestamp: document.getElementById("environmentTimestamp"),
    pointerPad: document.getElementById("pointerPad"),
    pointerEcho: document.getElementById("pointerEcho"),
    eventCount: document.getElementById("eventCount"),
    activePointerCount: document.getElementById("activePointerCount"),
    medianInterval: document.getElementById("medianInterval"),
    maxDistanceFromStart: document.getElementById("maxDistanceFromStart"),
    stationaryDriftRadius: document.getElementById("stationaryDriftRadius"),
    stepDistanceP95: document.getElementById("stepDistanceP95"),
    pointerEndCounts: document.getElementById("pointerEndCounts"),
    stationaryTestButton: document.getElementById("stationaryTestButton"),
    stationaryStatus: document.getElementById("stationaryStatus"),
    eventTableBody: document.getElementById("eventTableBody"),
    clearEventsButton: document.getElementById("clearEventsButton"),
    enumerateHidButton: document.getElementById("enumerateHidButton"),
    hidStatus: document.getElementById("hidStatus"),
    deviceList: document.getElementById("deviceList"),
    copyButton: document.getElementById("copyButton"),
    exportButton: document.getElementById("exportButton"),
    toast: document.getElementById("toast")
  };

  function createStationaryTestState() {
    return {
      status: "not-started",
      active: false,
      startedAt: null,
      endedAt: null,
      pointerId: null,
      originX: null,
      originY: null,
      maxRadiusPx: null,
      sampleCount: 0
    };
  }

  function formatNumber(value, digits) {
    return Number.isFinite(value) ? Number(value).toFixed(digits) : "--";
  }

  function formatHex(value) {
    const number = Number(value);
    return Number.isFinite(number) ? "0x" + number.toString(16).toUpperCase().padStart(4, "0") : "--";
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort(function sortNumbers(a, b) { return a - b; });
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function percentile(values, ratio) {
    if (!values.length) return null;
    const sorted = values.slice().sort(function sortNumbers(a, b) { return a - b; });
    const position = (sorted.length - 1) * ratio;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  }

  function pointerMoveStepP95() {
    return percentile(events
      .filter(function onlyMoves(item) { return item.type === "pointermove"; })
      .map(function readDistance(item) { return item.deltaDistancePx; })
      .filter(Number.isFinite), 0.95);
  }

  function collectEnvironment() {
    const visualViewport = window.visualViewport;
    const orientation = window.screen && window.screen.orientation;
    const hid = navigator.hid;
    return {
      buildRevision: BUILD_REVISION,
      diagnosticsSchemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      capturedAt: new Date().toISOString(),
      url: location.href,
      secureContext: Boolean(window.isSecureContext),
      userAgent: navigator.userAgent,
      platform: navigator.userAgentData && navigator.userAgentData.platform ? navigator.userAgentData.platform : navigator.platform,
      language: navigator.language,
      online: navigator.onLine,
      viewportCss: window.innerWidth + " x " + window.innerHeight,
      visualViewportCss: visualViewport ? Math.round(visualViewport.width) + " x " + Math.round(visualViewport.height) : "unavailable",
      screenCss: window.screen ? window.screen.width + " x " + window.screen.height : "unavailable",
      devicePixelRatio: window.devicePixelRatio,
      orientation: orientation ? orientation.type + " / " + orientation.angle : "unavailable",
      displayMode: window.matchMedia("(display-mode: standalone)").matches ? "standalone" : "browser",
      pointerEvent: "PointerEvent" in window,
      touchEvent: "TouchEvent" in window,
      maxTouchPoints: navigator.maxTouchPoints || 0,
      serviceWorker: "serviceWorker" in navigator,
      hidPresent: Boolean(hid),
      hidGetDevices: typeof hid?.getDevices === "function",
      hidRequestDevice: typeof hid?.requestDevice === "function"
    };
  }

  function renderEnvironment() {
    const environment = collectEnvironment();
    const labels = {
      buildRevision: "构建版本",
      diagnosticsSchemaVersion: "诊断格式",
      capturedAt: "读取时间",
      url: "页面地址",
      secureContext: "安全上下文",
      userAgent: "User Agent",
      platform: "平台",
      language: "语言",
      online: "网络状态",
      viewportCss: "页面视口 CSS px",
      visualViewportCss: "Visual Viewport",
      screenCss: "Screen CSS px",
      devicePixelRatio: "DPR",
      orientation: "方向",
      displayMode: "显示模式",
      pointerEvent: "Pointer Events",
      touchEvent: "Touch Events",
      maxTouchPoints: "最大触点数",
      serviceWorker: "Service Worker",
      hidPresent: "WebHID",
      hidGetDevices: "HID 已授权枚举",
      hidRequestDevice: "HID 新授权入口"
    };
    elements.environmentGrid.replaceChildren();
    Object.keys(labels).forEach(function appendEnvironmentItem(key) {
      const wrapper = document.createElement("div");
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = labels[key];
      description.textContent = String(environment[key]);
      wrapper.append(term, description);
      elements.environmentGrid.append(wrapper);
    });
    elements.environmentTimestamp.textContent = new Date(environment.capturedAt).toLocaleString();
    return environment;
  }

  function reportByteLength(report) {
    const bits = (report && report.items ? report.items : []).reduce(function sumBits(total, item) {
      const size = Number(item && item.reportSize) || 0;
      const count = Number(item && item.reportCount) || 0;
      return total + size * count;
    }, 0);
    return Math.ceil(bits / 8);
  }

  function summarizeReports(reports) {
    return (reports || []).map(function summarizeReport(report) {
      return {
        reportId: Number(report && report.reportId) || 0,
        byteLength: reportByteLength(report)
      };
    });
  }

  function summarizeCollections(collections) {
    return (collections || []).map(function summarizeCollection(collection) {
      return {
        usagePage: Number(collection && collection.usagePage) || 0,
        usage: Number(collection && collection.usage) || 0,
        inputReports: summarizeReports(collection && collection.inputReports),
        outputReports: summarizeReports(collection && collection.outputReports),
        featureReports: summarizeReports(collection && collection.featureReports),
        children: summarizeCollections(collection && collection.children)
      };
    });
  }

  function summarizeDevice(device, index) {
    return {
      index: index,
      vendorId: Number(device && device.vendorId) || 0,
      productId: Number(device && device.productId) || 0,
      productName: device && device.productName ? String(device.productName) : "未命名 HID",
      opened: Boolean(device && device.opened),
      collections: summarizeCollections(device && device.collections)
    };
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    toastTimer = window.setTimeout(function hideToast() {
      elements.toast.classList.remove("is-visible");
    }, 2800);
  }

  function scheduleEventRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    window.requestAnimationFrame(function renderFrame() {
      renderScheduled = false;
      renderEventSummary();
      renderEventTable();
    });
  }

  function renderStationaryStatus() {
    const labels = {
      "not-started": "尚未开始静止测试。",
      armed: "静止测试已开始，请按下一个主触点并保持不动 3–5 秒。",
      running: "正在记录触点 ID " + stationaryTest.pointerId + " 的静止漂移。",
      "awaiting-end": "触点已结束；请点击“结束静止测试”保存本阶段结果。",
      complete: "静止测试已完成，共 " + stationaryTest.sampleCount + " 个样本。",
      "no-samples": "静止测试已结束，但没有记录到有效样本。"
    };
    elements.stationaryStatus.textContent = labels[stationaryTest.status] || labels["not-started"];
    elements.stationaryTestButton.textContent = stationaryTest.active ? "结束静止测试" : "开始静止测试";
    elements.stationaryTestButton.setAttribute("aria-pressed", String(stationaryTest.active));
  }

  function renderEventSummary() {
    const intervals = events.map(function readInterval(item) { return item.deltaTimeMs; }).filter(function validInterval(value) {
      return Number.isFinite(value) && value > 0;
    });
    const medianValue = median(intervals);
    const stepP95 = pointerMoveStepP95();
    elements.eventCount.textContent = String(events.length);
    elements.activePointerCount.textContent = String(pointerState.size);
    elements.medianInterval.textContent = medianValue === null ? "-- ms" : formatNumber(medianValue, 1) + " ms";
    elements.maxDistanceFromStart.textContent = events.length ? formatNumber(maxDistanceFromStart, 1) + " px" : "-- px";
    elements.stationaryDriftRadius.textContent = stationaryTest.maxRadiusPx === null
      ? "-- px"
      : formatNumber(stationaryTest.maxRadiusPx, 2) + " px";
    elements.stepDistanceP95.textContent = stepP95 === null ? "-- px" : formatNumber(stepP95, 2) + " px";
    elements.pointerEndCounts.textContent = pointerCancelCount + " / " + lostPointerCaptureCount
      + (unexpectedLostPointerCaptureCount ? " (" + unexpectedLostPointerCaptureCount + " 异常)" : "");
    renderStationaryStatus();
  }

  function renderEventTable() {
    elements.eventTableBody.replaceChildren();
    if (!events.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 8;
      cell.className = "empty-row";
      cell.textContent = "尚未记录触摸事件";
      row.append(cell);
      elements.eventTableBody.append(row);
      return;
    }
    events.slice(-MAX_TABLE_ROWS).reverse().forEach(function appendEvent(item) {
      const row = document.createElement("tr");
      const cells = [
        formatNumber(item.elapsedMs, 1) + " ms",
        item.type,
        item.pointerId + " / " + item.pointerType,
        item.isPrimary ? "是" : "否",
        formatNumber(item.localX, 1) + ", " + formatNumber(item.localY, 1),
        formatNumber(item.deltaDistancePx, 2) + " px",
        formatNumber(item.speedPxPerSecond, 1) + " px/s",
        formatNumber(item.pressure, 2) + " / " + formatNumber(item.width, 1) + "×" + formatNumber(item.height, 1)
      ];
      cells.forEach(function appendCell(value) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      });
      elements.eventTableBody.append(row);
    });
  }

  function beginStationaryPointer(pointerId, localX, localY) {
    stationaryTest.pointerId = Number(pointerId);
    stationaryTest.originX = localX;
    stationaryTest.originY = localY;
    stationaryTest.maxRadiusPx = 0;
    stationaryTest.sampleCount = 0;
    stationaryTest.status = "running";
  }

  function updateStationaryTest(event, localX, localY) {
    if (!stationaryTest.active) return null;
    const isMotionSample = event.type === "pointerdown" || event.type === "pointermove";
    if (stationaryTest.pointerId === null && isMotionSample && event.isPrimary) {
      beginStationaryPointer(event.pointerId, localX, localY);
    }
    if (stationaryTest.pointerId !== Number(event.pointerId)) return null;
    if (event.type === "pointerup" || event.type === "pointercancel" || event.type === "lostpointercapture") {
      stationaryTest.status = "awaiting-end";
      return null;
    }
    if (!isMotionSample) return null;
    const radius = Math.hypot(localX - stationaryTest.originX, localY - stationaryTest.originY);
    stationaryTest.maxRadiusPx = Math.max(stationaryTest.maxRadiusPx || 0, radius);
    stationaryTest.sampleCount += 1;
    return radius;
  }

  function startStationaryTest() {
    stationaryTest = createStationaryTestState();
    stationaryTest.active = true;
    stationaryTest.startedAt = new Date().toISOString();
    stationaryTest.status = "armed";
    for (const [pointerId, state] of pointerState) {
      if (!state.isPrimary) continue;
      beginStationaryPointer(pointerId, state.x, state.y);
      stationaryTest.sampleCount = 1;
      break;
    }
    renderEventSummary();
    showToast("静止测试已开始。");
  }

  function endStationaryTest() {
    if (!stationaryTest.active) return false;
    stationaryTest.active = false;
    stationaryTest.endedAt = new Date().toISOString();
    stationaryTest.status = stationaryTest.sampleCount ? "complete" : "no-samples";
    renderEventSummary();
    showToast("静止测试已结束。");
    return true;
  }

  function toggleStationaryTest() {
    if (stationaryTest.active) endStationaryTest();
    else startStationaryTest();
  }

  function rememberPointerEnd(pointerId, reason) {
    pointerEndReason.delete(pointerId);
    pointerEndReason.set(pointerId, reason);
    while (pointerEndReason.size > 32) {
      pointerEndReason.delete(pointerEndReason.keys().next().value);
    }
  }

  function recordPointerEvent(event) {
    event.preventDefault();
    const rect = elements.pointerPad.getBoundingClientRect();
    const localX = Math.min(rect.width, Math.max(0, event.clientX - rect.left));
    const localY = Math.min(rect.height, Math.max(0, event.clientY - rect.top));
    const eventTime = Number(event.timeStamp) || performance.now();
    const existing = pointerState.get(event.pointerId);
    const priorEndReason = pointerEndReason.get(event.pointerId) || null;
    const afterPointerUp = event.type === "lostpointercapture" && priorEndReason === "pointerup";
    const afterPointerEnd = event.type === "lostpointercapture" && priorEndReason !== null;
    const unexpectedLostPointerCapture = event.type === "lostpointercapture" && Boolean(existing);
    let previous = existing;

    if (event.type === "pointerdown") {
      pointerEndReason.delete(event.pointerId);
      previous = {
        x: localX,
        y: localY,
        time: eventTime,
        originX: localX,
        originY: localY,
        pathLength: 0,
        isPrimary: Boolean(event.isPrimary)
      };
      pointerState.set(event.pointerId, previous);
      try { elements.pointerPad.setPointerCapture(event.pointerId); } catch (_) {}
    } else if (!previous) {
      previous = {
        x: localX,
        y: localY,
        time: eventTime,
        originX: localX,
        originY: localY,
        pathLength: 0,
        isPrimary: Boolean(event.isPrimary)
      };
    }

    const deltaX = localX - previous.x;
    const deltaY = localY - previous.y;
    const deltaDistance = Math.hypot(deltaX, deltaY);
    const deltaTime = Math.max(0, eventTime - previous.time);
    const speed = deltaTime > 0 ? deltaDistance * 1000 / deltaTime : 0;
    const distanceFromStart = Math.hypot(localX - previous.originX, localY - previous.originY);
    maxDistanceFromStart = Math.max(maxDistanceFromStart, distanceFromStart);

    if (event.type === "pointercancel") pointerCancelCount += 1;
    if (event.type === "lostpointercapture") {
      lostPointerCaptureCount += 1;
      if (unexpectedLostPointerCapture) unexpectedLostPointerCaptureCount += 1;
    }

    const stationaryDistance = updateStationaryTest(event, localX, localY);
    const record = {
      elapsedMs: performance.now(),
      wallClock: new Date().toISOString(),
      type: event.type,
      pointerId: Number(event.pointerId),
      pointerType: event.pointerType || "unknown",
      isPrimary: Boolean(event.isPrimary),
      buttons: Number(event.buttons) || 0,
      clientX: Number(event.clientX),
      clientY: Number(event.clientY),
      localX: localX,
      localY: localY,
      normalizedX: rect.width ? localX / rect.width : 0,
      normalizedY: rect.height ? localY / rect.height : 0,
      deltaTimeMs: event.type === "pointerdown" ? null : deltaTime,
      deltaDistancePx: event.type === "pointerdown" ? 0 : deltaDistance,
      distanceFromStartPx: distanceFromStart,
      pathLengthPx: previous.pathLength + deltaDistance,
      speedPxPerSecond: event.type === "pointerdown" ? 0 : speed,
      pressure: Number(event.pressure) || 0,
      tangentialPressure: Number(event.tangentialPressure) || 0,
      width: Number(event.width) || 0,
      height: Number(event.height) || 0,
      tiltX: Number(event.tiltX) || 0,
      tiltY: Number(event.tiltY) || 0,
      twist: Number(event.twist) || 0,
      afterPointerUp: afterPointerUp,
      afterPointerEnd: afterPointerEnd,
      unexpectedLostPointerCapture: unexpectedLostPointerCapture,
      stationaryTestActive: stationaryTest.active,
      stationaryDistancePx: stationaryDistance
    };

    events.push(record);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

    if (event.type === "pointerup" || event.type === "pointercancel") {
      rememberPointerEnd(event.pointerId, event.type);
    } else if (event.type === "lostpointercapture" && afterPointerEnd) {
      pointerEndReason.delete(event.pointerId);
    }

    if (event.type === "pointerup" || event.type === "pointercancel" || event.type === "lostpointercapture") {
      pointerState.delete(event.pointerId);
      elements.pointerEcho.classList.remove("is-visible");
    } else {
      pointerState.set(event.pointerId, {
        x: localX,
        y: localY,
        time: eventTime,
        originX: previous.originX,
        originY: previous.originY,
        pathLength: record.pathLengthPx,
        isPrimary: Boolean(event.isPrimary)
      });
      elements.pointerEcho.style.left = localX + "px";
      elements.pointerEcho.style.top = localY + "px";
      elements.pointerEcho.classList.add("is-visible");
    }
    scheduleEventRender();
  }

  function renderDevices() {
    elements.deviceList.replaceChildren();
    if (!hidEnumeration.devices.length) return;
    hidEnumeration.devices.forEach(function appendDevice(device) {
      const card = document.createElement("article");
      card.className = "device-item";
      const name = document.createElement("strong");
      name.textContent = device.productName;
      const list = document.createElement("dl");
      const entries = [
        ["VID / PID", formatHex(device.vendorId) + " / " + formatHex(device.productId)],
        ["当前 opened", String(device.opened)],
        ["顶层 Collections", String(device.collections.length)]
      ];
      entries.forEach(function appendEntry(entry) {
        const term = document.createElement("dt");
        const description = document.createElement("dd");
        term.textContent = entry[0];
        description.textContent = entry[1];
        list.append(term, description);
      });
      card.append(name, list);
      elements.deviceList.append(card);
    });
  }

  async function enumerateAuthorizedHid() {
    const getDevices = navigator.hid && navigator.hid.getDevices;
    if (typeof getDevices !== "function") {
      hidEnumeration = {
        status: "unsupported",
        checkedAt: new Date().toISOString(),
        durationMs: null,
        error: "当前环境未提供 navigator.hid.getDevices",
        devices: []
      };
      elements.hidStatus.textContent = hidEnumeration.error;
      renderDevices();
      return hidEnumeration;
    }

    elements.enumerateHidButton.disabled = true;
    elements.hidStatus.textContent = "正在只读检查已授权设备……";
    const started = performance.now();
    try {
      const devices = await getDevices.call(navigator.hid);
      hidEnumeration = {
        status: "complete",
        checkedAt: new Date().toISOString(),
        durationMs: performance.now() - started,
        error: null,
        devices: (devices || []).map(summarizeDevice)
      };
      elements.hidStatus.textContent = hidEnumeration.devices.length
        ? "已读取 " + hidEnumeration.devices.length + " 个已授权 HID；未打开、未写入。"
        : "未发现浏览器已授权的 HID；未弹出设备选择框。";
      renderDevices();
      return hidEnumeration;
    } catch (error) {
      hidEnumeration = {
        status: "error",
        checkedAt: new Date().toISOString(),
        durationMs: performance.now() - started,
        error: error instanceof Error ? error.message : String(error),
        devices: []
      };
      elements.hidStatus.textContent = "只读枚举失败：" + hidEnumeration.error;
      renderDevices();
      return hidEnumeration;
    } finally {
      elements.enumerateHidButton.disabled = false;
    }
  }

  function stationaryTestSnapshot() {
    return {
      status: stationaryTest.status,
      active: stationaryTest.active,
      startedAt: stationaryTest.startedAt,
      endedAt: stationaryTest.endedAt,
      pointerId: stationaryTest.pointerId,
      originX: stationaryTest.originX,
      originY: stationaryTest.originY,
      maxRadiusPx: stationaryTest.maxRadiusPx,
      sampleCount: stationaryTest.sampleCount
    };
  }

  function buildSnapshot() {
    return {
      buildRevision: BUILD_REVISION,
      diagnosticsSchemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      nonOutputDiagnostic: true,
      environment: collectEnvironment(),
      hidEnumeration: JSON.parse(JSON.stringify(hidEnumeration)),
      pointerSummary: {
        storedEventCount: events.length,
        maxEventCount: MAX_EVENTS,
        activePointerCount: pointerState.size,
        medianIntervalMs: median(events.map(function readInterval(item) { return item.deltaTimeMs; }).filter(Number.isFinite)),
        maxDistanceFromStartPx: maxDistanceFromStart,
        stationaryDriftRadiusPx: stationaryTest.maxRadiusPx,
        pointerMoveStepDistanceP95Px: pointerMoveStepP95(),
        pointerCancelCount: pointerCancelCount,
        lostPointerCaptureCount: lostPointerCaptureCount,
        unexpectedLostPointerCaptureCount: unexpectedLostPointerCaptureCount,
        stationaryTest: stationaryTestSnapshot()
      },
      events: events.map(function cloneEvent(item) { return Object.assign({}, item); })
    };
  }

  function snapshotJson() {
    return JSON.stringify(buildSnapshot(), null, 2);
  }

  async function copySnapshot() {
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") throw new Error("剪贴板 API 不可用");
      await navigator.clipboard.writeText(snapshotJson());
      showToast("诊断 JSON 已复制。");
    } catch (error) {
      showToast("复制失败：" + (error instanceof Error ? error.message : String(error)));
    }
  }

  function exportSnapshot() {
    const blob = new Blob([snapshotJson()], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    anchor.href = url;
    anchor.download = "ruyi-input-diagnostics-" + stamp + ".json";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(function releaseUrl() { URL.revokeObjectURL(url); }, 0);
    showToast("诊断 JSON 已导出。");
  }

  function clearEvents() {
    events.length = 0;
    pointerState.clear();
    pointerEndReason.clear();
    maxDistanceFromStart = 0;
    pointerCancelCount = 0;
    lostPointerCaptureCount = 0;
    unexpectedLostPointerCaptureCount = 0;
    stationaryTest = createStationaryTestState();
    elements.pointerEcho.classList.remove("is-visible");
    renderEventSummary();
    renderEventTable();
    showToast("触摸记录已清空。");
  }

  ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"].forEach(function bindPointer(type) {
    elements.pointerPad.addEventListener(type, recordPointerEvent);
  });
  elements.stationaryTestButton.addEventListener("click", toggleStationaryTest);
  elements.clearEventsButton.addEventListener("click", clearEvents);
  elements.enumerateHidButton.addEventListener("click", enumerateAuthorizedHid);
  elements.copyButton.addEventListener("click", copySnapshot);
  elements.exportButton.addEventListener("click", exportSnapshot);
  window.addEventListener("resize", renderEnvironment, { passive: true });

  renderEnvironment();
  renderEventSummary();
  renderEventTable();

  window.HapticDiagnostics = Object.freeze({
    buildRevision: BUILD_REVISION,
    diagnosticsSchemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    buildSnapshot: buildSnapshot,
    clearEvents: clearEvents,
    endStationaryTest: endStationaryTest,
    enumerateAuthorizedHid: enumerateAuthorizedHid,
    startStationaryTest: startStationaryTest
  });
})();