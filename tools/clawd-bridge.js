// One long-lived process that turns Claude Code hook payloads, forwarded by the
// clawd mod, into Clawd on Desk state posts. It runs the installed app's own
// hook code (buildStateBody, recovery lease, session history, POST) so the wire
// contract never drifts from what hooks/clawd-hook.js sends.
//
//   node clawd-bridge.js ensure --install-dir <app.asar.unpacked> --state-file <json>
//     prints {"port","pid","claudePid"}; starts the server if none is alive
//   node clawd-bridge.js serve --install-dir <dir> --state-file <json>
//   node clawd-bridge.js render-hooks --install-dir <dir> [--auto-start]
//     prints {"permission","autoStart"}: those two hook groups as the app's own
//     installer writes them, rendered into a scratch file, never settings.json
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const MAX_BODY_BYTES = 1024 * 1024;
const HOUSEKEEPING_MS = 30 * 1000;
const IDLE_EXIT_MS = 2 * 60 * 1000;
const LOG_MAX_BYTES = 256 * 1024;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 500 }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

async function ensure(installDir, stateFile) {
  const known = readJson(stateFile);
  if (known && alive(known.pid)) {
    const h = await health(known.port);
    if (h && h.app === "clawd-bar-bridge" && h.installDir === installDir) {
      return { port: known.port, pid: known.pid };
    }
  }
  const child = spawn(process.execPath, [__filename, "serve", "--install-dir", installDir, "--state-file", stateFile], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  for (let waited = 0; waited < 5000; waited += 50) {
    await new Promise((r) => setTimeout(r, 50));
    const next = readJson(stateFile);
    if (next && next.pid === child.pid) return { port: next.port, pid: next.pid };
  }
  throw new Error("bridge did not start");
}

function serve(installDir, stateFile) {
  const hooksDir = path.join(installDir, "hooks");
  const hookFile = path.join(hooksDir, "clawd-hook.js");
  const hook = require(hookFile);
  const { createPidResolver, getPlatformConfig } = require(path.join(hooksDir, "shared-process.js"));
  const { postStateToRunningServer } = require(path.join(hooksDir, "server-config.js"));
  const { fitStateBodyToByteBudget } = require(path.join(hooksDir, "state-payload-size.js"));
  const { updateRecoveryLeaseFromStateBody } = require(path.join(hooksDir, "session-recovery-lease.js"));
  const { recordSessionHistoryFromStateBody } = require(path.join(hooksDir, "session-history.js"));
  const hookMtimeMs = fs.statSync(hookFile).mtimeMs;
  const logFile = path.join(path.dirname(stateFile), "bridge.log");
  const platformConfig = getPlatformConfig();

  const log = (line) => {
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > LOG_MAX_BYTES) fs.truncateSync(logFile, 0);
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {}
  };

  // Mirrors main() in clawd-hook.js, with the walk starting at the Claude
  // process the mod runs in instead of the per-event hook wrapper's parent.
  const resolvers = new Map();
  const resolverFor = (claudePid) => {
    let entry = resolvers.get(claudePid);
    if (!entry) {
      const resolver = createPidResolver({
        agentNames: { win: new Set(["claude.exe"]), mac: new Set(["claude"]) },
        agentCmdlineCheck: (cmd) => cmd.includes("claude-code") || cmd.includes("@anthropic-ai"),
        headlessCheck: hook.isClaudeHeadlessCommandLine,
        platformConfig,
        startPid: claudePid || undefined,
      });
      entry = { lastSeen: Date.now() };
      // createPidResolver memoises its first walk, and one taken while the app
      // was offline carries no terminal pid. Drop it so the next event retries.
      entry.resolve = (opts) => {
        const result = resolver(opts);
        if (!result || !result.stablePid) resolvers.delete(claudePid);
        return result;
      };
      resolvers.set(claudePid, entry);
    }
    entry.lastSeen = Date.now();
    return entry.resolve;
  };

  let queue = Promise.resolve();
  let lastEventAt = Date.now();
  let handled = 0;
  let posted = 0;
  let lastError = null;

  const handle = ({ event, payload, claudePid, eventAt }) => {
    const body = hook.buildStateBody(event, payload || {}, resolverFor(claudePid));
    if (!body) return Promise.resolve();
    const at = Number.isFinite(eventAt) ? eventAt : Date.now();
    const fitted = fitStateBodyToByteBudget(body);
    updateRecoveryLeaseFromStateBody(body, { eventAt: at });
    recordSessionHistoryFromStateBody(body, { eventAt: at });
    const timeoutMs = body.event === "Stop" ? 1500 : 100;
    return new Promise((resolve) => {
      postStateToRunningServer(JSON.stringify(fitted.body), { timeoutMs }, (isPosted) => {
        if (isPosted) posted += 1;
        resolve();
      });
    });
  };

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, app: "clawd-bar-bridge", pid: process.pid, installDir, handled, posted, lastError }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/event") {
      res.writeHead(404);
      res.end();
      return;
    }
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      let item;
      try {
        item = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      res.writeHead(202);
      res.end();
      lastEventAt = Date.now();
      queue = queue
        .then(() => handle(item))
        .then(() => { handled += 1; })
        .catch((err) => {
          lastError = String((err && err.message) || err);
          log(`${item && item.event}: ${lastError}`);
        });
    });
  });

  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, port, installDir, startedAt: Date.now() }));
    log(`listening on ${port}`);
  });

  setInterval(() => {
    const mine = readJson(stateFile);
    if (!mine || mine.pid !== process.pid) process.exit(0);
    // An app update replaced the hook code this process loaded: step aside and
    // let the mod's next ensure start a fresh bridge on the new code.
    try {
      if (fs.statSync(hookFile).mtimeMs !== hookMtimeMs) process.exit(0);
    } catch {
      process.exit(0);
    }
    for (const pid of resolvers.keys()) {
      if (!alive(pid)) resolvers.delete(pid);
    }
    if (resolvers.size === 0 && Date.now() - lastEventAt > IDLE_EXIT_MS) process.exit(0);
  }, HOUSEKEEPING_MS);
}

function renderHooks(installDir, autoStart) {
  const { registerHooks } = require(path.join(installDir, "hooks", "install.js"));
  const scratch = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clawd-bar-")), "settings.json");
  try {
    fs.writeFileSync(scratch, "{}\n");
    registerHooks({
      silent: true,
      autoStart,
      settingsPath: scratch,
      backup: false,
      claudeVersionInfo: { version: null, source: null, status: "unknown" },
    });
    const hooks = (readJson(scratch) || {}).hooks || {};
    const find = (groups, test) => (groups || []).find((g) => (g.hooks || []).some(test)) || null;
    return {
      permission: find(hooks.PermissionRequest, (h) => h.type === "http"),
      autoStart: autoStart ? find(hooks.SessionStart, (h) => /auto-start\.js/.test(h.command || "")) : null,
    };
  } finally {
    fs.rmSync(path.dirname(scratch), { recursive: true, force: true });
  }
}

const mode = process.argv[2];
const installDir = arg("--install-dir");
const stateFile = arg("--state-file");
if (mode === "render-hooks" && installDir) {
  try {
    process.stdout.write(`${JSON.stringify(renderHooks(installDir, process.argv.includes("--auto-start")))}\n`);
  } catch (err) {
    // A failed require appends its whole require stack.
    process.stderr.write(`${String(err.message).split("\n")[0]}\n`);
    process.exit(1);
  }
} else if (!installDir || !stateFile || (mode !== "ensure" && mode !== "serve")) {
  process.stderr.write("usage: clawd-bridge.js ensure|serve --install-dir <dir> --state-file <json>\n       clawd-bridge.js render-hooks --install-dir <dir> [--auto-start]\n");
  process.exit(2);
} else if (mode === "serve") {
  serve(installDir, stateFile);
} else {
  ensure(installDir, stateFile)
    .then((info) => {
      process.stdout.write(`${JSON.stringify({ ...info, claudePid: process.ppid })}\n`);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}
