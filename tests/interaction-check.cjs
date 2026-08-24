const { installNoDeviceHid, launchChromium } = require("./test-runtime.cjs");

const BASE_URL = process.env.INTERACTION_TEST_URL || "http://127.0.0.1:4173";

async function run() {
  const browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await installNoDeviceHid(page);
  await page.goto(BASE_URL + "/#knob", { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#protocolBadge")?.textContent.includes("4/4"));

  const box = await page.locator("#mediaShell").boundingBox();
  if (!box) throw new Error("Interaction stage is missing");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const radius = Math.min(box.width, box.height) * 0.31;
  await page.mouse.move(cx + radius, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + radius, { steps: 8 });
  await page.mouse.move(cx - radius, cy, { steps: 8 });
  const frequency = Number(await page.locator("#liveFrequency").textContent());
  const transform = await page.locator("#demoImage").evaluate(element => element.style.transform);
  if (!Number.isFinite(frequency) || frequency < 16 || frequency > 96) throw new Error(`Knob frequency is invalid: ${frequency}`);
  if (!transform.includes("rotate")) throw new Error("Knob image did not rotate");
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector("#interactionState")?.textContent === "等待触摸");

  await page.locator('.rail-item[data-index="1"]').click();
  await page.waitForFunction(() => document.querySelector("#chapterTitle")?.textContent === "凸起纹理再现");
  await page.waitForTimeout(250);
  const surfaceTransform = await page.locator("#demoImage").evaluate(element => element.style.transform);
  if (surfaceTransform !== "none" && surfaceTransform !== "") throw new Error(`Surface image inherited knob rotation: ${surfaceTransform}`);
  await page.locator("#themeButton").click();
  if ((await page.locator("html").getAttribute("data-theme")) !== "dark") throw new Error("Theme toggle did not enter dark mode");

  await browser.close();
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(JSON.stringify({ status: "PASS", knobFrequency: frequency, knobTransform: transform }));
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
