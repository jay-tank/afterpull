"use strict";

// Launches a real, isolated VS Code window with AfterPull loaded from this folder and runs
// test/vscode/index.js inside it. Usage: node test/run-vscode.js [tmpBaseDir]

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { makeMainRepo, makeHostileRepo } = require("./fixtures");

const extDir = path.resolve(__dirname, "..");
const base = fs.mkdtempSync(path.join(process.argv[2] || os.tmpdir(), "ap-vscode-"));
const main = makeMainRepo(path.join(base, "ws", "main"));
const outsideDir = path.join(base, "outside");
const markerDir = path.join(base, "markers");
const hostile = makeHostileRepo(path.join(base, "ws2", "hostile"), outsideDir, markerDir, { execHooks: false });

const userDir = path.join(base, "user");
const extsDir = path.join(base, "exts");
fs.mkdirSync(path.join(userDir, "User"), { recursive: true });
fs.mkdirSync(extsDir, { recursive: true });
const writeMarker = (name) => `node -e "require('fs').writeFileSync('${name}', process.cwd())"`;
fs.writeFileSync(
  path.join(userDir, "User", "settings.json"),
  JSON.stringify({
    "security.workspace.trust.enabled": false,
    "git.autoRepositoryDetection": true,
    "git.openRepositoryInParentFolders": "never",
    "git.autofetch": false,
    "extensions.autoUpdate": false,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "workbench.startupEditor": "none",
    "task.allowAutomaticTasks": "off",
    "afterpull.ignore": ["examples/**", "docs/"],
    "afterpull.commands": {
      npm: writeMarker("ap-npm-ran.txt"),
      pnpm: "node -e \"process.exit(3)\"",
    },
    "afterpull.rules": [{ glob: "proto/**/*.proto", command: writeMarker("ap-proto-ran.txt"), label: "Regenerate protobuf code", cwd: "file" }],
  }, null, 2)
);
const wsFile = path.join(base, "test.code-workspace");
fs.writeFileSync(wsFile, JSON.stringify({ folders: [{ path: main.root }, { path: hostile.root }] }, null, 2));

const resultFile = path.join(base, "results.json");
const cfgFile = path.join(base, "config.json");
const cfg = { main, hostile, outsideDir, markerDir, resultFile };
fs.writeFileSync(cfgFile, JSON.stringify(cfg));

function launch(extraArgs, workspace) {
  const args = [
    "--wait", "--new-window",
    "--user-data-dir", userDir,
    "--extensions-dir", extsDir,
    "--disable-extensions",
    ...extraArgs,
    "--skip-welcome", "--skip-release-notes",
    "--extensionDevelopmentPath=" + extDir,
    "--extensionTestsPath=" + path.join(__dirname, "vscode", "index.js"),
    workspace || wsFile,
  ];
  console.log("code " + args.join(" "));
  const r = spawnSync("code", args, { stdio: "inherit", env: Object.assign({}, process.env, { AP_TEST_CONFIG: cfgFile }), timeout: 300000 });
  console.log("code exit status:", r.status);
  if (!fs.existsSync(resultFile)) {
    console.log("FAIL: no results written");
    return { passed: 0, failed: 1, results: [] };
  }
  const res = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  fs.unlinkSync(resultFile);
  for (const t of res.results) console.log((t.ok ? "PASS " : "FAIL ") + t.name + (t.detail ? " :: " + t.detail : ""));
  return res;
}

// Run 1: trusted (workspace trust disabled), full suite.
const r1 = launch(["--disable-workspace-trust"]);

// Run 2: workspace trust enabled and the workspace not trusted: AfterPull must stay idle.
const settingsPath = path.join(userDir, "User", "settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
settings["security.workspace.trust.enabled"] = true;
settings["security.workspace.trust.startupPrompt"] = "never";
delete settings["afterpull.enabled"];
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
fs.writeFileSync(cfgFile, JSON.stringify(Object.assign({ mode: "untrusted" }, cfg)));
const r2 = launch([]);

// Run 3: trusted, a folder that is not a git repository: the "no git repo" empty state.
settings["security.workspace.trust.enabled"] = false;
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
const plainDir = path.join(base, "plain");
fs.mkdirSync(plainDir, { recursive: true });
fs.writeFileSync(path.join(plainDir, "README.txt"), "not a git repository\n");
const plainWs = path.join(base, "plain.code-workspace");
fs.writeFileSync(plainWs, JSON.stringify({ folders: [{ path: plainDir }] }, null, 2));
fs.writeFileSync(cfgFile, JSON.stringify(Object.assign({ mode: "norepo" }, cfg)));
const r3 = launch(["--disable-workspace-trust"], plainWs);

const passed = r1.passed + r2.passed + r3.passed;
const failed = r1.failed + r2.failed + r3.failed;
console.log(`\nin-editor tests: ${passed} passed, ${failed} failed (trusted run ${r1.passed}/${r1.passed + r1.failed}, untrusted run ${r2.passed}/${r2.passed + r2.failed}, no-repo run ${r3.passed}/${r3.passed + r3.failed})`);
process.exit(failed ? 1 : 0);
