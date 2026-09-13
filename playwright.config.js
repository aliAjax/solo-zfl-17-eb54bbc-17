const { defineConfig } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

// 无 root 环境：把手动下载解压的 Chromium arm64 依赖库注入 LD_LIBRARY_PATH
const depRoot = "/tmp/chromedeps/root";
if (fs.existsSync(depRoot)) {
  const dirs = [];
  for (const dir of ["usr/lib", "usr/lib/aarch64-linux-gnu", "lib", "lib/aarch64-linux-gnu"]) {
    const p = path.join(depRoot, dir);
    if (fs.existsSync(p)) dirs.push(p);
  }
  if (dirs.length) {
    process.env.LD_LIBRARY_PATH = [...dirs, process.env.LD_LIBRARY_PATH || ""].join(":");
  }
}

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30000,
  expect: { timeout: 8000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8137",
    trace: "retain-on-failure",
    launchOptions: {
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    }
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "python3 -m http.server 8137 --bind 127.0.0.1",
    url: "http://127.0.0.1:8137/index.html",
    reuseExistingServer: true,
    cwd: __dirname
  }
});
