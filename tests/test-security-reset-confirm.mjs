#!/usr/bin/env node
// #255 P1-8: /security/reset requires confirm:"RESET" and appends an audit
// broadcast message; without confirm it is rejected 400.
import assert from "node:assert/strict";
import { handleSecurityResetRequest } from "../src/dist/src/controller/security.js";

function fakeReq(body) {
  const payload = Buffer.from(JSON.stringify(body));
  return {
    headers: {},
    on(event, cb) {
      if (event === "data") cb(payload);
      if (event === "end") cb();
    },
    destroy() {},
  };
}

function fakeRes() {
  const out = { status: 0, body: null, headers: {} };
  return {
    out,
    getHeader: (name) => out.headers[String(name).toLowerCase()],
    setHeader: (name, value) => { out.headers[String(name).toLowerCase()] = value; },
    writeHead(status, headers) {
      out.status = status;
      for (const [k, v] of Object.entries(headers ?? {})) out.headers[k.toLowerCase()] = v;
    },
    end(chunk) { if (chunk) out.body = JSON.parse(String(chunk)); },
  };
}

function fakeDeps() {
  const state = {
    teamName: "t",
    profileId: "software-rd",
    version: 1,
    workers: {}, tasks: {}, controllerRuns: {}, projects: {}, messages: [],
    clarifications: {}, previews: {}, reports: {}, createdAt: 0, updatedAt: 0,
    security: { devices: [{ id: "d1", name: "Dev", tokenHash: "x", pairedAt: 0 }] },
  };
  return {
    state,
    getTeamState: () => state,
    updateTeamState: (fn) => fn(state),
    logger: { info() {}, warn() {}, error() {} },
  };
}

const mkCtx = (body, { loopback = true } = {}) => ({
  req: fakeReq(body),
  res: fakeRes(),
  peer: loopback ? { ip: "127.0.0.1", loopback: true } : { ip: "9.9.9.9", loopback: false },
  deps: fakeDeps(),
});

// 1. No confirm -> 400, state untouched.
{
  const ctx = mkCtx({});
  await handleSecurityResetRequest(ctx);
  assert.equal(ctx.res.out.status, 400, "missing confirm must be rejected 400");
  assert.ok(ctx.res.out.body.error.includes('confirm:"RESET"'), "400 body must explain the confirm requirement");
  assert.ok(ctx.deps.state.security, "rejected reset must not clear protection");
  assert.equal(ctx.deps.state.messages.length, 0, "rejected reset must not append an audit message");
}

// 2. With confirm -> 200, security cleared, audit broadcast appended.
{
  const ctx = mkCtx({ confirm: "RESET" });
  await handleSecurityResetRequest(ctx);
  assert.equal(ctx.res.out.status, 200, 'confirm:"RESET" must pass');
  assert.ok(!ctx.deps.state.security, "confirmed reset clears protection to L0");
  const audit = ctx.deps.state.messages.at(-1);
  assert.ok(audit, "confirmed reset appends an audit message");
  assert.equal(audit.type, "broadcast");
  assert.ok(audit.content.includes("protection reset"), "audit message describes the reset");
  assert.ok(audit.content.includes("confirm"), "audit message records the confirm step");
}

// 3. Wrong confirm value -> still 400.
{
  const ctx = mkCtx({ confirm: "reset" });
  await handleSecurityResetRequest(ctx);
  assert.equal(ctx.res.out.status, 400, "confirm is case-sensitive; anything but exact RESET is rejected");
}

// 4. Unauthenticated non-loopback peer -> 401 before confirm check.
{
  const ctx = mkCtx({ confirm: "RESET" }, { loopback: false });
  await handleSecurityResetRequest(ctx);
  assert.equal(ctx.res.out.status, 401, "non-loopback peers without a device token stay rejected");
}

console.log("test-security-reset-confirm: ok (confirm gate + audit broadcast)");
