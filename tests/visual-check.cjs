const fs = require("node:fs");
const path = require("node:path");
const { installNoDeviceHid, launchChromium } = require("./test-runtime.cjs");

const BASE_URL = process.env.VISUAL_TEST_URL || "http://127.0.0.1:4173";

const outputDir = process.env.TEST_ARTIFACT_DIR || path.resolve(__dirname, "artifacts");
fs.mkdirSync(outputDir, { recursive: true });

async function run() {
  const browser = await launchChromium();
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 1024 }, deviceScaleFactor: 1 });
  const errors = [];
  desktop.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  desktop.on("console", message => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });

  await installNoDeviceHid(desktop);
  await desktop.goto(BASE_URL + "/#knob", { waitUntil: "networkidle" });
  await desktop.waitForFunction(() => document.querySelector("#protocolBadge")?.textContent.includes("4/4"));
  const firstTitle = await desktop.locator("#chapterTitle").textContent();
  if (firstTitle.trim() !== "旋钮纹理再现") throw new Error(`Unexpected first title: ${firstTitle}`);
  if (!(await desktop.locator("#outputButton").isDisabled())) throw new Error("Output must default to disabled before device connection");

  const imageBox = await desktop.locator("#demoImage").boundingBox();
  if (!imageBox || imageBox.width < 200 || imageBox.height < 200) throw new Error("Primary image did not render at usable size");
  await desktop.screenshot({ path: path.join(outputDir, "desktop-knob.png"), fullPage: false });

  await desktop.locator('.material-chip[data-index="2"]').click();
  await desktop.waitForFunction(() => document.querySelector("#chapterTitle")?.textContent === "化石纹理再现");
  await desktop.waitForTimeout(700);
  await desktop.screenshot({ path: path.join(outputDir, "desktop-fossil.png"), fullPage: false });

  await desktop.locator('.material-chip[data-index="3"]').click();
  await desktop.waitForFunction(() => document.querySelector("#chapterTitle")?.textContent === "橡胶纹理再现");
  await desktop.waitForFunction(() => document.querySelector("#demoImage")?.naturalWidth > 0);
  await desktop.waitForTimeout(500);
  await desktop.screenshot({ path: path.join(outputDir, "desktop-rubber.png"), fullPage: false });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  mobile.on("pageerror", error => errors.push(`mobile pageerror: ${error.message}`));
  await installNoDeviceHid(mobile);
  await mobile.goto(BASE_URL + "/#bump", { waitUntil: "networkidle" });
  await mobile.waitForFunction(() => document.querySelector("#chapterTitle")?.textContent === "凸起纹理再现");
  const copyBox = await mobile.locator("#fixedCopy").boundingBox();
  const stripBox = await mobile.locator(".material-strip").boundingBox();
  if (!copyBox || !stripBox || copyBox.y + copyBox.height > stripBox.y + 1) throw new Error("Mobile copy panel overlaps bottom navigation");
  const outputBox = await mobile.locator("#outputButton").boundingBox();
  if (!outputBox || outputBox.x + outputBox.width > 390) throw new Error("Mobile output button is hidden or outside the viewport");
  await mobile.screenshot({ path: path.join(outputDir, "mobile-bump.png"), fullPage: false });

  const diagnostics = await browser.newPage({ viewport: { width: 1024, height: 900 }, deviceScaleFactor: 1 });
  diagnostics.on("pageerror", error => errors.push("diagnostics pageerror: " + error.message));
  await installNoDeviceHid(diagnostics);
  await diagnostics.goto(BASE_URL + "/diagnostics.html", { waitUntil: "networkidle" });
  await diagnostics.waitForFunction(() => document.querySelector("#environmentGrid")?.children.length > 10);
  if (!(await diagnostics.locator(".safe-badge").textContent()).includes("零触觉输出")) throw new Error("Diagnostics safety boundary is missing");
  await diagnostics.screenshot({ path: path.join(outputDir, "diagnostics.png"), fullPage: true });

  await browser.close();
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(JSON.stringify({ status: "PASS", screenshots: ["desktop-knob.png", "desktop-fossil.png", "desktop-rubber.png", "mobile-bump.png", "diagnostics.png"] }));
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
