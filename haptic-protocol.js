(function exposeHapticProtocol(globalObject) {
  "use strict";

  const BASELINES = [
    ["02-square", () => buildReport(buildSignalPayload(0, 56, 121, 50, "方波", 0.3)), "8F224E180B546C97C3D3E8D9776B52F8B2C52E975660F9CC09AA8DEBA49BBB22"],
    ["04-sine", () => buildReport(buildSignalPayload(0, 60, 121, 50, "正弦波", 0.3)), "106CB1E6A0A4A036FDC6D0DDEA8EDCBADB17F1ABD6328CC76613AFE5752297EC"],
    ["05-square", () => buildReport(buildSignalPayload(0, 20, 121, 50, "方波", 0.3)), "343906502DAA687FD80EC35B3D68CB1C5BD8CB5CCF5ABA9E0C1932E6347173DD"],
    ["stop", () => buildReport(buildStopPayload()), "4C976BF86C91DF65791EF74E20A68A4EB01AE1A4E23525967314B6F90D7C3D30"]
  ];

  function equalBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  }

  function voltageToWord(voltage) {
    const safe = Math.min(500, Math.max(0, Number(voltage) || 0));
    return Math.trunc(3399 - safe / 500 * 1351);
  }

  function writeUint16LE(target, offset, value) {
    const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
    view.setUint16(offset, Math.max(0, Math.min(65535, Math.trunc(value))), true);
  }

  function buildSignalPayload(count, frequency, magnitude, offset, shape, param) {
    const waveform = new Uint8Array(52);
    const writeVoltage = (sample, voltage) => writeUint16LE(waveform, sample * 2, voltageToWord(voltage));
    if (shape === "三角波") {
      for (let i = 0; i <= 13; i += 1) writeVoltage(i, magnitude * i / 13 + offset);
      for (let i = 14; i < 26; i += 1) writeVoltage(i, magnitude * (26 - i) / 13 + offset);
    } else if (shape === "方波") {
      const highCount = Math.trunc(26 * param + 0.5);
      for (let i = 0; i < highCount; i += 1) writeVoltage(i, magnitude + offset);
      for (let i = highCount; i < 26; i += 1) writeVoltage(i, offset);
    } else if (shape === "锯齿波") {
      for (let i = 0; i < 26; i += 1) writeVoltage(i, magnitude * (25 - i) / 25 + offset);
    } else if (shape === "正弦波") {
      const halfMagnitude = Math.trunc(magnitude / 2);
      for (let i = 0; i < 26; i += 1) writeVoltage(i, halfMagnitude * Math.sin(i / 26 * 2 * Math.PI) + halfMagnitude + offset);
    }
    const payload = new Uint8Array(64);
    payload[0] = 128;
    writeUint16LE(payload, 1, count);
    writeUint16LE(payload, 3, frequency);
    payload.set(waveform, 5);
    return payload;
  }

  function buildStopPayload() {
    const payload = new Uint8Array(64);
    payload[0] = 131;
    return payload;
  }

  function buildReport(payload) {
    if (!(payload instanceof Uint8Array) || payload.length !== 64) throw new Error("触觉有效载荷必须为64字节");
    const report = new Uint8Array(65);
    report[0] = 0;
    report.set(payload, 1);
    return report;
  }

  async function sha256Hex(bytes) {
    if (globalObject.crypto?.subtle) {
      const hash = await globalObject.crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
    }
    if (typeof require === "function") return require("node:crypto").createHash("sha256").update(bytes).digest("hex").toUpperCase();
    throw new Error("当前环境没有可用的 SHA-256 实现");
  }

  async function selfTest() {
    const results = [];
    for (const [name, build, expected] of BASELINES) {
      const report = build();
      const actual = await sha256Hex(report);
      results.push({ name, passed: actual === expected, expected, actual, length: report.length });
    }
    const passed = results.filter(result => result.passed).length;
    return { passed, total: results.length, results };
  }

  const api = { BASELINES, buildReport, buildSignalPayload, buildStopPayload, equalBytes, selfTest, voltageToWord };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalObject.HapticProtocol = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
