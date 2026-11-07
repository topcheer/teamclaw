// S0 scenario runner: starts the packaged app (hermetic, external-disk UD),
// drives it over CDP, asserts DOM (not screenshots).
import { spawn } from "node:child_process";
const UD = process.env.TC_UD || "/Volumes/new/tc-test/s0-ud";
const BIN = "/Volumes/new/ggai/teamclaw/.ggcode/worktrees/ui-s0/desktop/dist/mac-arm64/TeamClaw Desktop.app/Contents/MacOS/TeamClaw Desktop";
const { mkdirSync, writeFileSync } = await import("node:fs");
try { mkdirSync(UD, { recursive: true }); writeFileSync(`${UD}/settings.json`, JSON.stringify({ controllerUrl: "http://127.0.0.1:9529", theme: "system" })); } catch {}
const child = spawn(BIN, ["--remote-debugging-port=9333", `--user-data-dir=${UD}`], { stdio: "ignore", env: { ...process.env } });
const stop = () => { try { child.kill("SIGTERM"); } catch {} };
process.on("exit", stop);
// wait for CDP
for (let i = 0; i < 30; i++) {
  try { await fetch("http://127.0.0.1:9333/json/list"); break; } catch { await new Promise(r => setTimeout(r, 500)); }
}
const cdp = async (expr) => {
  const r = await (await fetch("http://127.0.0.1:9333/json/list")).json();
  const page = r.find(t => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  return await new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { ws.close(); resolve(d.result?.result?.value); } };
    setTimeout(() => reject(new Error("cdp-timeout")), 8000);
  });
};
const step = process.argv[2] || "probe";
if (step === "probe") {
  const title = await cdp("document.title");
  const wizardVisible = await cdp("!!document.getElementById('bootstrap-overlay') && !document.getElementById('bootstrap-overlay').classList.contains('hidden')");
  const buttons = await cdp("[...document.querySelectorAll('.bootstrap-actions button, #bootstrap-install-btn')].map(b => b.textContent.trim()).filter(Boolean)");
  console.log(JSON.stringify({ title, wizardVisible, buttons }, null, 1));
  process.exit(0);
}
console.error("unknown step", step); process.exit(1);
