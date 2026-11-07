// Bundled-runtime self-extraction: installers ship resources/bin/runtime.tgz
// (compressed form - the old unpacked 1GB tree bloated every install). On
// first use we extract it into the user-data dir and cache by tar
// fingerprint (size+mtime) so upgrades re-extract exactly once.
//
// Pure module - no electron imports - so it can be smoke-tested with plain
// node (see scripts/ below). Callers pass the resolved paths.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function bundledRuntimeTarPath(resourcesBinDir) {
  return path.join(resourcesBinDir || "", "runtime.tgz");
}

// Legacy / dev shape: unpacked tree next to the tar (resources/bin/runtime).
export function unpackedRuntimeDir(resourcesBinDir) {
  return path.join(resourcesBinDir || "", "runtime");
}

function openclawEntry(dir) {
  try {
    fs.accessSync(path.join(dir, "node_modules", "openclaw", "openclaw.mjs"));
    return true;
  } catch {
    return false;
  }
}

function tarFingerprint(tarPath) {
  try {
    const st = fs.statSync(tarPath);
    return `${st.size}-${st.mtimeMs}`;
  } catch {
    return null;
  }
}

// tar on Windows: PATH may lack it, but System32\tar.exe ships with Win10+.
function tarCommand() {
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  const sysTar = path.join(sysRoot, "System32", "tar.exe");
  if (process.platform === "win32" && fs.existsSync(sysTar)) return sysTar;
  return "tar";
}

function runTar(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(tarCommand(), args, { cwd, windowsHide: true });
    let err = "";
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar ${args.join(" ")} failed (${code}): ${err.trim().slice(0, 400)}`))));
  });
}

/**
 * Create a platform launcher shim for the extracted runtime's openclaw
 * entry. The bundled entry is openclaw.mjs - a NODE script. On Windows .mjs
 * has no file association: spawning it through a shell pops the "choose an
 * app to open .mjs" dialog (user-found). The shim runs it under Electron's
 * embedded Node (ELECTRON_RUN_AS_NODE=1) so no system Node is needed.
 * Idempotent; returns the shim path.
 */
export function makeOpenclawShim(runtimeDir, electronPath) {
  if (!runtimeDir || !electronPath) return null;
  const entry = path.join(runtimeDir, "node_modules", "openclaw", "openclaw.mjs");
  if (!fs.existsSync(entry)) return null;
  const shimDir = path.join(path.dirname(runtimeDir), "shims");
  fs.mkdirSync(shimDir, { recursive: true });
  if (process.platform === "win32") {
    const shim = path.join(shimDir, "openclaw.cmd");
    const body = `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${electronPath}" "${entry}" %*\r\n`;
    fs.writeFileSync(shim, body, { flag: "w" });
    return shim;
  }
  const shim = path.join(shimDir, "openclaw");
  const body = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 "${electronPath}" "${entry}" "$@"\n`;
  fs.writeFileSync(shim, body, { mode: 0o755, flag: "w" });
  return shim;
}

/**
 * Resolve the bundled runtime dir, extracting runtime.tgz on first use.
 * @param {{resourcesBinDir: string, userDataDir: string, onEvent?: (e:{phase:string,line:string})=>void}} opts
 * @returns {Promise<string|null>} usable runtime dir (node_modules/openclaw inside), or null when nothing bundled
 */
export async function ensureBundledRuntime(opts) {
  const { resourcesBinDir, userDataDir, onEvent } = opts || {};
  const emit = (line) => { if (onEvent) onEvent({ phase: "runtime", line }); };
  if (!resourcesBinDir || !userDataDir) return null;

  // 1) Unpacked tree ships with the package (dev runs / legacy builds).
  const unpacked = unpackedRuntimeDir(resourcesBinDir);
  if (openclawEntry(unpacked)) return unpacked;

  // 2) Compressed form: extract into userData/bundled/runtime once.
  const tarPath = bundledRuntimeTarPath(resourcesBinDir);
  if (!fs.existsSync(tarPath)) return null;
  const destRoot = path.join(userDataDir, "bundled");
  const dest = path.join(destRoot, "runtime");
  const marker = path.join(destRoot, "EXTRACTED-FROM");
  const fp = tarFingerprint(tarPath);
  if (openclawEntry(dest) && fp) {
    let prev = null;
    try { prev = fs.readFileSync(marker, "utf8").trim(); } catch { /* none */ }
    if (prev === fp) return dest; // cached, same tar
  }
  emit("Preparing the bundled runtime (first launch, one-time extraction)...");
  fs.rmSync(destRoot, { recursive: true, force: true });
  fs.mkdirSync(destRoot, { recursive: true });
  // Archive's top level is `runtime/` - extract into destRoot.
  await runTar(["-xzf", tarPath], destRoot);
  if (!openclawEntry(dest)) throw new Error("Bundled runtime extraction produced no openclaw entry");
  fs.writeFileSync(marker, fp || String(Date.now()));
  emit("Bundled runtime ready.");
  return dest;
}
