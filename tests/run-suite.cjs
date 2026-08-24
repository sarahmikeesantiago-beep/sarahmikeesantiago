const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const HOST = "127.0.0.1";
const PORT = Number(process.env.TEST_PORT || 4173);
const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function serve(request, response) {
  try {
    const requestUrl = new URL(request.url, "http://" + HOST + ":" + PORT);
    let pathname = decodeURIComponent(requestUrl.pathname).replace(/\\/g, "/");
    if (pathname === "/") pathname = "/index.html";
    const target = path.resolve(ROOT, "." + pathname);
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    fs.stat(target, (statError, stats) => {
      if (statError || !stats.isFile()) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream"
      });
      fs.createReadStream(target).on("error", () => response.destroy()).pipe(response);
    });
  } catch (_) {
    response.writeHead(400).end("Bad request");
  }
}

function runScript(script, extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, script)], {
      cwd: ROOT,
      env: Object.assign({}, process.env, extraEnvironment),
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", code => {
      if (code === 0) resolve();
      else reject(new Error(script + " exited with code " + code));
    });
  });
}

async function run() {
  const server = http.createServer(serve);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolve);
  });
  const baseUrl = "http://" + HOST + ":" + PORT;
  try {
    await runScript("webhid-transport-check.cjs");
    await runScript("webhid-browser-check.cjs", { WEBHID_TEST_URL: baseUrl });
    await runScript("diagnostics-check.cjs", { DIAGNOSTICS_TEST_URL: baseUrl });
    await runScript("interaction-check.cjs", { INTERACTION_TEST_URL: baseUrl });
    await runScript("visual-check.cjs", {
      VISUAL_TEST_URL: baseUrl,
      TEST_ARTIFACT_DIR: path.join(ROOT, "tests", "artifacts")
    });
    await runScript("github-pages-smoke.cjs", { PAGES_SMOKE_URL: baseUrl + "/" });
    console.log(JSON.stringify({ status: "PASS", suite: "ruyi-web-v1.1.0", physicalHid: "not-used" }));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});