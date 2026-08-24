"use strict";

(function initializeDiagnostics() {
  const MAX_EVENTS = 500;
  const MAX_TABLE_ROWS = 80;
  const events = [];
  const pointerState = new Map();
  let renderScheduled = false;
  let toastTimer = 0;
  let maxObservedDrift = 0;
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
    maxDrift: document.getElementById("maxDrift"),
    eventTableBody: document.getElementById("eventTableBody"),
    clearEventsButton: document.getElementById("clearEventsButton"),
    enumerateHidButton: document.getElementById("enumerateHidButton"),
    hidStatus: document.getElementById("hidStatus"),
    deviceList: document.getElementById("deviceList"),
    copyButton: document.getElementById("copyButton"),
    exportButton: document.getElementById("exportButton"),
    toast: document.getElementById("toast")
  };

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

  function collectEnvironment() {
    const visualViewport = window.visualViewport;
    const orientation = window.screen && window.screen.orientation;
    const hid = navigator.hid;
    return {
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

  function renderEventSummary() {
    const intervals = events.map(function readInterval(item) { return item.deltaTimeMs; }).filter(function validInterval(value) {
      return Number.isFinite(value) && value > 0;
    });
    const medianValue = median(intervals);
    elements.eventCount.textContent = String(events.length);
    elements.activePointerCount.textContent = String(pointerState.size);
    elements.medianInterval.textContent = medianValue === null ? "-- ms" : formatNumber(medianValue, 1) + " ms";
    elements.maxDrift.textContent = events.length ? formatNumber(maxObservedDrift, 1) + " px" : "-- px";
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

  function recordPointerEvent(event) {
    event.preventDefault();
    const rect = elements.pointerPad.getBoundingClientRect();
    const localX = Math.min(rect.width, Math.max(0, event.clientX - rect.left));
    const localY = Math.min(rect.height, Math.max(0, event.clientY - rect.top));
    const eventTime = Number(event.timeStamp) || performance.now();
    let previous = pointerState.get(event.pointerId);

    if (event.type === "pointerdown" || !previous) {
      previous = {
        x: localX,
        y: localY,
        time: eventTime,
        originX: localX,
        originY: localY,
        pathLength: 0
      };
      pointerState.set(event.pointerId, previous);
      try { elements.pointerPad.setPointerCapture(event.pointerId); } catch (_) {}
    }

    const deltaX = localX - previous.x;
    const deltaY = localY - previous.y;
    const deltaDistance = Math.hypot(deltaX, deltaY);
    const deltaTime = Math.max(0, eventTime - previous.time);
    const speed = deltaTime > 0 ? deltaDistance * 1000 / deltaTime : 0;
    const distanceFromStart = Math.hypot(localX - previous.originX, localY - previous.originY);
    maxObservedDrift = Math.max(maxObservedDrift, distanceFromStart);

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
      twist: Number(event.twist) || 0
    };

    events.push(record);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

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
        pathLength: record.pathLengthPx
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

  function buildSnapshot() {
    return {
      schemaVersion: "ruyi-input-diagnostics-v1",
      generatedAt: new Date().toISOString(),
      nonOutputDiagnostic: true,
      environment: collectEnvironment(),
      hidEnumeration: JSON.parse(JSON.stringify(hidEnumeration)),
      pointerSummary: {
        storedEventCount: events.length,
        maxEventCount: MAX_EVENTS,
        activePointerCount: pointerState.size,
        medianIntervalMs: median(events.map(function readInterval(item) { return item.deltaTimeMs; }).filter(Number.isFinite)),
        maxDistanceFromStartPx: maxObservedDrift
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
    maxObservedDrift = 0;
    elements.pointerEcho.classList.remove("is-visible");
    renderEventSummary();
    renderEventTable();
    showToast("触摸记录已清空。");
  }

  ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"].forEach(function bindPointer(type) {
    elements.pointerPad.addEventListener(type, recordPointerEvent);
  });
  elements.clearEventsButton.addEventListener("click", clearEvents);
  elements.enumerateHidButton.addEventListener("click", enumerateAuthorizedHid);
  elements.copyButton.addEventListener("click", copySnapshot);
  elements.exportButton.addEventListener("click", exportSnapshot);
  window.addEventListener("resize", renderEnvironment, { passive: true });

  renderEnvironment();
  renderEventSummary();
  renderEventTable();

  window.HapticDiagnostics = Object.freeze({
    buildSnapshot: buildSnapshot,
    enumerateAuthorizedHid: enumerateAuthorizedHid
  });
})();