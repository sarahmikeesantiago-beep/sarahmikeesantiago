const assert = require("node:assert/strict");
const { installNoDeviceHid, launchChromium } = require("./test-runtime.cjs");

const baseUrl = process.env.PAGES_SMOKE_URL || "http://127.0.0.1:4174/";

async function run() {
  const browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });

  await installNoDeviceHid(page);
  const response = await page.goto(`${baseUrl}#knob`, { waitUntil: "networkidle" });
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => document.querySelector("#protocolBadge")?.textContent.includes("4/4"));

  const expectedTitles = ["旋钮纹理再现", "凸起纹理再现", "化石纹理再现", "橡胶纹理再现"];
  for (let index = 0; index < expectedTitles.length; index += 1) {
    await page.locator(`.material-chip[data-index="${index}"]`).click();
    await page.waitForFunction(
      title => document.querySelector("#chapterTitle")?.textContent === title,
      expectedTitles[index]
    );
    assert.equal(await page.locator("#chapterTitle").textContent(), expectedTitles[index]);
    await page.waitForFunction(
      () => {
        const image = document.querySelector("#demoImage");
        return Boolean(image?.complete && image.naturalWidth > 0);
      },
      { timeout: 15_000 }
    );
  }

  assert.equal(await page.locator("#outputButton").isDisabled(), true);

  const diagnostics = await browser.newPage({ viewport: { width: 1024, height: 820 } });
  diagnostics.on("pageerror", error => errors.push("diagnostics pageerror: " + error.message));
  diagnostics.on("console", message => {
    if (message.type() === "error") errors.push("diagnostics console: " + message.text());
  });
  await installNoDeviceHid(diagnostics);
  const diagnosticsResponse = await diagnostics.goto(baseUrl + "diagnostics.html", { waitUntil: "networkidle" });
  assert.equal(diagnosticsResponse.status(), 200);
  await diagnostics.waitForFunction(() => document.querySelector("#environmentGrid")?.children.length > 10);
  assert.match(await diagnostics.locator(".safe-badge").textContent(), /零触觉输出/);
  assert.equal(await diagnostics.locator("#hidStatus").textContent(), "尚未检查");

  await browser.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "PASS", chapters: expectedTitles.length, protocol: "4/4", diagnostics: "zero-output" }));
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
