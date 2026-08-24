const { chromium } = require("playwright");

async function launchChromium(options = {}) {
  const launchOptions = Object.assign({ headless: true }, options);
  const channelSetting = process.env.PLAYWRIGHT_CHANNEL;
  const requestedChannel = channelSetting === "none"
    ? ""
    : channelSetting || (process.platform === "win32" ? "msedge" : "");
  if (requestedChannel && !Object.prototype.hasOwnProperty.call(launchOptions, "channel")) {
    launchOptions.channel = requestedChannel;
  }
  try {
    return await chromium.launch(launchOptions);
  } catch (error) {
    if (!launchOptions.channel || process.env.PLAYWRIGHT_CHANNEL) throw error;
    delete launchOptions.channel;
    return chromium.launch(launchOptions);
  }
}

async function installNoDeviceHid(page) {
  await page.addInitScript(() => {
    const counters = { getDevices: 0, requestDevice: 0 };
    const hid = {
      addEventListener() {},
      async getDevices() {
        counters.getDevices += 1;
        return [];
      },
      async requestDevice() {
        counters.requestDevice += 1;
        return [];
      }
    };
    Object.defineProperty(navigator, "hid", { configurable: true, value: hid });
    Object.defineProperty(window, "__noDeviceHidCounters", { configurable: true, value: counters });
  });
}

module.exports = {
  installNoDeviceHid,
  launchChromium
};