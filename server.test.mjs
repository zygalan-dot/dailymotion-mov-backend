import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const PORT = 18081;
let child;

test.before(async () => {
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("test server did not start");
});

test.after(() => child?.kill("SIGTERM"));

test("health endpoint responds", async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test("rejects non-Dailymotion URLs", async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/video", rightsConfirmed: true }),
  });
  assert.equal(response.status, 400);
});

test("requires rights confirmation", async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://www.dailymotion.com/video/x84sh87" }),
  });
  assert.equal(response.status, 400);
});

test("blocks unapproved browser origins", async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ url: "https://www.dailymotion.com/video/x84sh87", rightsConfirmed: true }),
  });
  assert.equal(response.status, 403);
});
