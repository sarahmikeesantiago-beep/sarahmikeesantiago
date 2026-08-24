"use strict";

const {
  buildSignalPayload,
  selfTest: runProtocolSelfTest
} = HapticProtocol;
const { WebHidTransport } = HapticTransport;

const MATERIALS = [
  {
    id: "knob",
    short: "旋钮",
    title: "旋钮纹理再现",
    english: "ROTARY HAPTIC TEXTURE",
    image: "assets/knob.jpg",
    alt: "银色机械旋钮",
    type: "knob",
    description: "沿旋钮外缘按住并拖动。转动速度会映射为触觉频率，让机械刻度在指尖形成连续反馈。",
    instruction: "单指接触旋钮外环并拖动；松开后立即停止输出。",
    wave: "方波",
    frequency: "16–96 Hz",
    magnitude: "135",
    stageHint: "按住外环后旋转"
  },
  {
    id: "bump",
    short: "凸起",
    title: "凸起纹理再现",
    english: "RAISED DOT TEXTURE",
    image: "assets/bump.jpg",
    alt: "规则排列的金属凸点",
    type: "surface",
    description: "规则排列的离散凸点被转换为稳定的方波刺激。手指持续滑动时，可以感到清晰、均匀的颗粒节奏。",
    instruction: "在图像区域内按住并连续滑动；离开或松开即停止输出。",
    wave: "方波",
    frequency: "20 Hz",
    magnitude: "121",
    stageHint: "横向或斜向连续滑动"
  },
  {
    id: "fossil",
    short: "化石",
    title: "化石纹理再现",
    english: "FOSSIL RELIEF TEXTURE",
    image: "assets/fossil.jpg",
    alt: "具有骨骼纹理的化石图像",
    type: "surface",
    description: "局部纹理尺度决定输出频率。滑过骨骼、沟槽与石质背景时，反馈会随粗糙结构产生层次变化。",
    instruction: "缓慢滑过骨骼边缘与背景区域，对比不同局部尺度的反馈。",
    wave: "方波",
    frequency: "7–42 Hz",
    magnitude: "121",
    stageHint: "沿骨骼边缘缓慢滑动"
  },
  {
    id: "rubber",
    short: "橡胶",
    title: "橡胶纹理再现",
    english: "RUBBER SURFACE TEXTURE",
    image: "assets/rubber.jpg",
    alt: "橡胶材质表面",
    type: "surface",
    description: "连续正弦刺激模拟均匀、细密并带有阻尼感的橡胶表面，使反馈比凸起纹理更平滑。",
    instruction: "在图像区域内按住并匀速滑动，感受连续正弦刺激。",
    wave: "正弦波",
    frequency: "60 Hz",
    magnitude: "121",
    stageHint: "保持匀速连续滑动"
  }
];

const elements = {
  root: document.documentElement,
  fixedCopy: document.getElementById("fixedCopy"),
  chapterNumber: document.getElementById("chapterNumber"),
  chapterTitle: document.getElementById("chapterTitle"),
  chapterEnglish: document.getElementById("chapterEnglish"),
  chapterDescription: document.getElementById("chapterDescription"),
  chapterInstruction: document.getElementById("chapterInstruction"),
  metaWave: document.getElementById("metaWave"),
  metaFrequency: document.getElementById("metaFrequency"),
  metaMagnitude: document.getElementById("metaMagnitude"),
  liveFrequency: document.getElementById("liveFrequency"),
  liveWave: document.getElementById("liveWave"),
  interactionState: document.getElementById("interactionState"),
  ambientGlyph: document.getElementById("ambientGlyph"),
  mediaShell: document.getElementById("mediaShell"),
  demoImage: document.getElementById("demoImage"),
  interactionSurface: document.getElementById("interactionSurface"),
  pointerMarker: document.getElementById("pointerMarker"),
  touchRipple: document.getElementById("touchRipple"),
  stageHint: document.getElementById("stageHint"),
  stageCoordinates: document.getElementById("stageCoordinates"),
  protocolBadge: document.getElementById("protocolBadge"),
  themeButton: document.getElementById("themeButton"),
  deviceButton: document.getElementById("deviceButton"),
  deviceButtonText: document.getElementById("deviceButtonText"),
  outputButton: document.getElementById("outputButton"),
  railProgress: document.getElementById("railProgress"),
  stripProgress: document.getElementById("stripProgress"),
  toast: document.getElementById("toast")
};

const chapters = Array.from(document.querySelectorAll(".scroll-chapter"));
const railItems = Array.from(document.querySelectorAll(".rail-item"));
const chips = Array.from(document.querySelectorAll(".material-chip"));

let activeIndex = -1;
let pointerActive = false;
let activePointerId = null;
let knobAngle = 0;
let knobStartPointerAngle = 0;
let knobStartRotation = 0;
let lastKnobAngle = 0;
let lastKnobTime = 0;
let lastSurfaceSend = 0;
let toastTimer = 0;
let fossilSampler = null;
let materialRenderGeneration = 0;

const transport = new WebHidTransport();
transport.onState = updateDeviceState;
transport.onError = handleTransportError;
transport.onWatchdog = () => {
  if (pointerActive) elements.interactionState.textContent = "等待继续移动";
};
async function runPacketSelfTest() {
  const result = await runProtocolSelfTest();
  if (result.passed !== result.total) {
    const failed = result.results.find(item => !item.passed);
    throw new Error(`${failed.name} 数据不一致`);
  }
  elements.protocolBadge.textContent = `数据协议 ${result.passed}/${result.total}`;
  return result;
}

function scrollProgress() {
  const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  return Math.min(1, Math.max(0, window.scrollY / max));
}

function updateScrollState() {
  const progress = scrollProgress();
  elements.railProgress.style.height = `${progress * 100}%`;
  elements.stripProgress.style.width = `${progress * 100}%`;
  const sectionHeight = Math.max(1, chapters[0]?.getBoundingClientRect().height || window.innerHeight);
  const nextIndex = Math.min(MATERIALS.length - 1, Math.max(0, Math.round(window.scrollY / sectionHeight)));
  if (nextIndex !== activeIndex) setActiveMaterial(nextIndex);
}

function setActiveMaterial(index, pushHash = false) {
  const next = MATERIALS[index];
  if (!next || index === activeIndex) return;
  stopInteraction();
  activeIndex = index;
  const renderGeneration = ++materialRenderGeneration;

  elements.fixedCopy.classList.remove("is-swapping");
  elements.ambientGlyph.classList.add("is-swapping");
  void elements.fixedCopy.offsetWidth;

  elements.chapterNumber.textContent = String(index + 1).padStart(2, "0");
  elements.chapterTitle.textContent = next.title;
  elements.chapterEnglish.textContent = next.english;
  elements.chapterDescription.textContent = next.description;
  elements.chapterInstruction.textContent = next.instruction;
  elements.metaWave.textContent = next.wave;
  elements.metaFrequency.textContent = next.frequency;
  elements.metaMagnitude.textContent = next.magnitude;
  elements.liveFrequency.textContent = "--";
  elements.liveWave.textContent = next.wave;
  elements.interactionState.textContent = "等待触摸";
  elements.stageHint.textContent = next.stageHint;
  elements.stageCoordinates.textContent = "X -- / Y --";
  elements.interactionSurface.setAttribute("aria-label", `触摸并拖动${next.short}材质`);

  elements.demoImage.classList.add("is-swapping");
  window.setTimeout(() => {
    if (renderGeneration !== materialRenderGeneration) return;
    elements.demoImage.src = next.image;
    elements.demoImage.alt = next.alt;
    elements.demoImage.style.transform = next.type === "knob" ? `rotate(${knobAngle}deg)` : "none";
    elements.demoImage.className = `demo-image ${next.type === "knob" ? "is-knob" : "is-surface"}`;
    elements.mediaShell.classList.toggle("is-knob", next.type === "knob");
    elements.mediaShell.classList.toggle("is-surface", next.type !== "knob");
    if (next.id === "fossil") prepareFossilSampler();
  }, 175);

  window.setTimeout(() => {
    if (renderGeneration !== materialRenderGeneration) return;
    elements.ambientGlyph.textContent = next.short;
    elements.ambientGlyph.classList.remove("is-swapping");
  }, 160);

  elements.fixedCopy.classList.add("is-swapping");
  railItems.forEach((item, itemIndex) => {
    const selected = itemIndex === index;
    item.classList.toggle("is-active", selected);
    item.toggleAttribute("aria-current", selected);
  });
  chips.forEach((chip, chipIndex) => {
    const selected = chipIndex === index;
    chip.classList.toggle("is-active", selected);
    chip.setAttribute("aria-selected", selected ? "true" : "false");
  });

  const desiredHash = `#${next.id}`;
  if (pushHash) history.pushState(null, "", desiredHash);
  else history.replaceState(null, "", desiredHash);
}

function navigateTo(index) {
  const chapter = chapters[index];
  if (!chapter) return;
  stopInteraction();
  chapter.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  history.pushState(null, "", `#${MATERIALS[index].id}`);
}

function mapCoverPoint(clientX, clientY, imageRect, naturalWidth, naturalHeight) {
  const boxWidth = Math.max(1, imageRect.width);
  const boxHeight = Math.max(1, imageRect.height);
  const imageX = Math.min(boxWidth, Math.max(0, clientX - imageRect.left));
  const imageY = Math.min(boxHeight, Math.max(0, clientY - imageRect.top));
  const sourceWidth = naturalWidth > 0 ? naturalWidth : boxWidth;
  const sourceHeight = naturalHeight > 0 ? naturalHeight : boxHeight;
  const scale = Math.max(boxWidth / sourceWidth, boxHeight / sourceHeight);
  const renderedWidth = sourceWidth * scale;
  const renderedHeight = sourceHeight * scale;
  const cropX = Math.max(0, (renderedWidth - boxWidth) / 2);
  const cropY = Math.max(0, (renderedHeight - boxHeight) / 2);
  return {
    nx: Math.min(1, Math.max(0, (imageX + cropX) / renderedWidth)),
    ny: Math.min(1, Math.max(0, (imageY + cropY) / renderedHeight))
  };
}
function localPoint(event) {
  const rect = elements.mediaShell.getBoundingClientRect();
  const imageRect = elements.demoImage.getBoundingClientRect();
  const x = Math.min(rect.width, Math.max(0, event.clientX - rect.left));
  const y = Math.min(rect.height, Math.max(0, event.clientY - rect.top));
  const insideImage = event.clientX >= imageRect.left && event.clientX <= imageRect.right && event.clientY >= imageRect.top && event.clientY <= imageRect.bottom;
  const imagePoint = mapCoverPoint(
    event.clientX,
    event.clientY,
    imageRect,
    elements.demoImage.naturalWidth,
    elements.demoImage.naturalHeight
  );
  return {
    x,
    y,
    nx: x / Math.max(1, rect.width),
    ny: y / Math.max(1, rect.height),
    imageNx: imagePoint.nx,
    imageNy: imagePoint.ny,
    insideImage,
    rect
  };
}

function pointerAngle(point) {
  const cx = point.rect.width / 2;
  const cy = point.rect.height / 2;
  return Math.atan2(point.y - cy, point.x - cx) * 180 / Math.PI;
}

function normalizedDelta(from, to) {
  let delta = to - from;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

function beginInteraction(event) {
  if (event.button !== undefined && event.button > 0) return;
  if (pointerActive || event.isPrimary === false) return;
  const material = MATERIALS[activeIndex];
  if (!material) return;
  const point = localPoint(event);

  if (material.type === "knob") {
    const dx = point.x - point.rect.width / 2;
    const dy = point.y - point.rect.height / 2;
    const radius = Math.hypot(dx, dy);
    const validRadius = Math.min(point.rect.width, point.rect.height) * 0.42;
    if (radius < validRadius * 0.26 || radius > validRadius * 1.08) {
      elements.interactionState.textContent = "请触摸旋钮外环";
      return;
    }
  } else if (!point.insideImage) {
    elements.interactionState.textContent = "请触摸图片区域";
    return;
  }

  pointerActive = true;
  activePointerId = event.pointerId;
  elements.mediaShell.classList.add("is-interacting");
  try { elements.interactionSurface.setPointerCapture?.(event.pointerId); } catch (_) {}
  positionPointer(point);
  pulseAt(point);
  elements.interactionState.textContent = transport.outputEnabled ? "正在输出" : "交互预览";

  if (material.type === "knob") {
    knobStartPointerAngle = pointerAngle(point);
    knobStartRotation = knobAngle;
    lastKnobAngle = knobAngle;
    lastKnobTime = performance.now();
  } else {
    sendSurfaceSignal(material, point, true);
  }
}

function moveInteraction(event) {
  const point = localPoint(event);
  document.documentElement.style.setProperty("--pointer-x", (point.nx - 0.5).toFixed(3));
  document.documentElement.style.setProperty("--pointer-y", (point.ny - 0.5).toFixed(3));
  if (!pointerActive || event.pointerId !== activePointerId) return;
  positionPointer(point);
  const material = MATERIALS[activeIndex];
  if (material.type === "knob") updateKnob(point);
  else if (point.insideImage) sendSurfaceSignal(material, point, false);
  else stopInteraction();
}

function positionPointer(point) {
  elements.pointerMarker.style.left = `${point.x}px`;
  elements.pointerMarker.style.top = `${point.y}px`;
  elements.stageCoordinates.textContent = `X ${Math.round(point.nx * 100)} / Y ${Math.round((1 - point.ny) * 100)}`;
}

function pulseAt(point) {
  elements.touchRipple.classList.remove("pulse");
  elements.touchRipple.style.left = `${point.x}px`;
  elements.touchRipple.style.top = `${point.y}px`;
  void elements.touchRipple.offsetWidth;
  elements.touchRipple.classList.add("pulse");
}

function updateKnob(point) {
  const currentPointerAngle = pointerAngle(point);
  const nextAngle = knobStartRotation + normalizedDelta(knobStartPointerAngle, currentPointerAngle);
  const now = performance.now();
  const elapsed = Math.max(8, now - lastKnobTime);
  const angularSpeed = Math.abs(normalizedDelta(lastKnobAngle, nextAngle)) / elapsed * 1000;
  knobAngle = nextAngle;
  elements.demoImage.style.transform = `rotate(${knobAngle}deg)`;
  const lineSpeed = Math.min(50, Math.max(1, angularSpeed * Math.PI * 350 / 180 / 100));
  const frequency = Math.min(96, Math.max(16, 2 * Math.round(lineSpeed * 10 / 80) * 8));
  elements.liveFrequency.textContent = String(frequency);
  elements.liveWave.textContent = "方波";
  elements.interactionState.textContent = transport.outputEnabled ? "正在输出" : "旋转预览";
  lastKnobAngle = nextAngle;
  lastKnobTime = now;
  safelySend(buildSignalPayload(0, frequency, 135, 50, "方波", 0.5));
}

function sendSurfaceSignal(material, point, force) {
  const now = performance.now();
  if (!force && now - lastSurfaceSend < 28) return;
  lastSurfaceSend = now;
  let frequency = material.id === "bump" ? 20 : material.id === "rubber" ? 60 : sampleFossilFrequency(point.imageNx, point.imageNy);
  const shape = material.id === "rubber" ? "正弦波" : "方波";
  elements.liveFrequency.textContent = String(frequency);
  elements.liveWave.textContent = shape;
  elements.interactionState.textContent = transport.outputEnabled ? "正在输出" : "滑动预览";
  safelySend(buildSignalPayload(0, frequency, 121, 50, shape, 0.3));
}

function prepareFossilSampler() {
  const image = elements.demoImage;
  const build = () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      fossilSampler = { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
    } catch (_) {
      fossilSampler = null;
    }
  };
  if (image.complete && image.naturalWidth) build();
  else image.addEventListener("load", build, { once: true });
}

function fossilPixelPoint(nx, ny, width, height) {
  return {
    x: Math.min(width - 65, Math.max(64, Math.floor(nx * width))),
    y: Math.min(height - 65, Math.max(64, Math.floor(ny * height)))
  };
}

function sampleFossilFrequency(nx, ny) {
  if (!fossilSampler) return 28;
  const { width, height, data } = fossilSampler;
  const { x, y } = fossilPixelPoint(nx, ny, width, height);
  let bestScale = 1;
  let bestDifference = -1;
  const grayAt = (px, py) => {
    const index = (Math.min(height - 1, Math.max(0, py)) * width + Math.min(width - 1, Math.max(0, px))) * 4;
    return (data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114);
  };
  for (let scale = 1; scale <= 6; scale += 1) {
    const radius = 2 ** scale;
    const step = Math.max(1, radius >> 3);
    let left = 0, right = 0, upper = 0, lower = 0, samples = 0;
    for (let offset = -radius / 2; offset <= radius / 2; offset += step) {
      left += grayAt(x - radius, y + offset);
      right += grayAt(x + radius, y + offset);
      upper += grayAt(x + offset, y - radius);
      lower += grayAt(x + offset, y + radius);
      samples += 1;
    }
    const difference = Math.max(Math.abs(left - right), Math.abs(upper - lower)) / Math.max(1, samples);
    if (difference > bestDifference) {
      bestDifference = difference;
      bestScale = scale;
    }
  }
  return 7 * bestScale;
}

async function safelySend(payload) {
  try {
    await transport.sendPayload(payload);
  } catch (error) {
    if (!transport.faulted) handleTransportError(error);
  }
}

function handleTransportError(error) {
  const message = error instanceof Error ? error.message : String(error || "触觉设备通信失败");
  transport.outputEnabled = false;
  elements.outputButton.setAttribute("aria-pressed", "false");
  elements.outputButton.textContent = "触觉输出：关闭";
  updateDeviceState(transport.state, message);
  showToast(`发送已停止：${message}`, 5200);
}

function endInteraction(event) {
  if (!pointerActive) return;
  if (event && activePointerId !== null && event.pointerId !== activePointerId) return;
  stopInteraction();
}

function stopInteraction() {
  const pointerId = activePointerId;
  pointerActive = false;
  activePointerId = null;
  try {
    if (pointerId !== null && elements.interactionSurface.hasPointerCapture?.(pointerId)) {
      elements.interactionSurface.releasePointerCapture(pointerId);
    }
  } catch (_) {}
  elements.mediaShell.classList.remove("is-interacting");
  elements.interactionState.textContent = "等待触摸";
  if (transport.outputEnabled) {
    transport.stop(true).catch(error => {
      if (!transport.faulted) handleTransportError(error);
    });
  }
}

async function connectDevice() {
  try {
    if (transport.device?.opened) {
      await transport.disconnect();
      showToast("触觉设备已安全断开。", 3200);
      return;
    }
    await transport.connect();
    showToast("设备已连接。触觉输出仍保持关闭，请手动开启。", 4200);
  } catch (error) {
    handleTransportError(error);
  }
}

function updateDeviceState(state, label) {
  const connected = state === "connected" && transport.device?.opened && !transport.faulted;
  const outputAvailable = connected && transport.protocolReady;
  elements.deviceButton.disabled = state === "connecting";
  elements.deviceButton.classList.toggle("is-connected", connected);
  elements.deviceButton.classList.toggle("is-error", state === "error");
  elements.deviceButtonText.textContent = connected ? "断开触觉设备" : state === "connecting" ? "正在连接" : "连接触觉设备";
  elements.deviceButton.title = label || "";
  elements.outputButton.disabled = !outputAvailable;
  if (!outputAvailable || !transport.outputEnabled) {
    elements.outputButton.setAttribute("aria-pressed", "false");
    elements.outputButton.textContent = "触觉输出：关闭";
  }
}

async function toggleOutput() {
  if (!transport.device?.opened) return;
  try {
    const enabled = !transport.outputEnabled;
    if (enabled) await transport.enableOutput();
    else await transport.disableOutput();
    elements.outputButton.setAttribute("aria-pressed", enabled ? "true" : "false");
    elements.outputButton.textContent = enabled ? "触觉输出：开启" : "触觉输出：关闭";
    showToast(enabled ? "触觉输出已开启；请在材质区域内操作。" : "触觉输出已关闭并发送停止信号。", 3600);
  } catch (error) {
    if (!transport.faulted) handleTransportError(error);
  }
}

function showToast(message, duration = 3200) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), duration);
}

function applySavedTheme() {
  let saved = null;
  try { saved = localStorage.getItem("haptic-atlas-theme"); } catch (_) {}
  const dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  elements.root.dataset.theme = dark ? "dark" : "light";
  elements.themeButton.setAttribute("aria-pressed", dark ? "true" : "false");
}

function toggleTheme() {
  const dark = elements.root.dataset.theme !== "dark";
  elements.root.dataset.theme = dark ? "dark" : "light";
  elements.themeButton.setAttribute("aria-pressed", dark ? "true" : "false");
  try { localStorage.setItem("haptic-atlas-theme", dark ? "dark" : "light"); } catch (_) {}
}

function bindEvents() {
  window.addEventListener("scroll", updateScrollState, { passive: true });
  window.addEventListener("resize", updateScrollState, { passive: true });
  window.addEventListener("hashchange", () => {
    const index = MATERIALS.findIndex(item => `#${item.id}` === location.hash);
    if (index >= 0) navigateTo(index);
  });

  railItems.forEach(item => item.addEventListener("click", () => navigateTo(Number(item.dataset.index))));
  chips.forEach(item => item.addEventListener("click", () => navigateTo(Number(item.dataset.index))));

  elements.interactionSurface.addEventListener("pointerdown", beginInteraction);
  elements.interactionSurface.addEventListener("pointermove", moveInteraction);
  elements.interactionSurface.addEventListener("pointerup", endInteraction);
  elements.interactionSurface.addEventListener("pointercancel", endInteraction);
  elements.interactionSurface.addEventListener("lostpointercapture", endInteraction);

  elements.themeButton.addEventListener("click", toggleTheme);
  elements.deviceButton.addEventListener("click", connectDevice);
  elements.outputButton.addEventListener("click", toggleOutput);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopInteraction();
  });
  window.addEventListener("blur", stopInteraction);
  window.addEventListener("pagehide", stopInteraction);
  window.addEventListener("keydown", event => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      navigateTo(Math.min(MATERIALS.length - 1, activeIndex + 1));
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      navigateTo(Math.max(0, activeIndex - 1));
    }
  });
}

async function init() {
  applySavedTheme();
  bindEvents();
  const hashIndex = MATERIALS.findIndex(item => `#${item.id}` === location.hash);
  const initialIndex = hashIndex >= 0 ? hashIndex : 0;
  if (initialIndex > 0) window.scrollTo(0, initialIndex * window.innerHeight);
  setActiveMaterial(initialIndex);
  updateScrollState();
  updateDeviceState("disconnected", transport.supported ? "等待协议自检" : "当前环境不支持WebHID");
  try {
    await runPacketSelfTest();
    transport.setProtocolReady(true);
    updateDeviceState(transport.state, transport.stateLabel || "协议自检已通过");
  } catch (error) {
    transport.setProtocolReady(false);
    elements.protocolBadge.textContent = "协议自检失败";
    elements.protocolBadge.style.color = "var(--danger)";
    updateDeviceState(transport.state, "协议自检失败，已禁止物理输出");
    showToast(`触觉协议自检失败：${error.message}`, 5200);
  }
}

init();
