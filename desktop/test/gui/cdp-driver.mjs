// Zero-dep CDP driver for TeamClaw Desktop (node>=18 global WebSocket).
// Launch app with --remote-debugging-port=9333 first.
// Usage: node cdp-driver.mjs <js-expression>
const port = process.env.CDP_PORT || 9333;
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) { console.error("NO_PAGE"); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
const id = 1;
const expr = process.argv[2];
ws.onopen = () => ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id === id) {
    const r = d.result?.result;
    console.log(JSON.stringify(r?.value ?? r?.description ?? r, null, 1));
    ws.close(); process.exit(0);
  }
};
setTimeout(() => { console.error("TIMEOUT"); process.exit(3); }, 8000);
