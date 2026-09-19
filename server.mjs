import http from "node:http";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import {
  PORT,
  consumeRateLimit,
  corsHeaders,
  parseDailymotionUrl,
  readBody,
  requireAllowedOrigin,
  writeJson,
} from "./config.mjs";
import {
  cleanupAll,
  createJob,
  downloadName,
  getJob,
  publicJob,
  queueStatus,
  removeJob,
} from "./jobs.mjs";

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", "http://backend.local");
  const cors = corsHeaders(req);

  if (req.method === "OPTIONS") {
    if (!requireAllowedOrigin(req, res)) return;
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    writeJson(res, 200, { ok: true, ...queueStatus() }, cors);
    return;
  }

  if (!requireAllowedOrigin(req, res)) return;

  if (req.method === "POST" && requestUrl.pathname === "/jobs") {
    if (!consumeRateLimit(req)) {
      writeJson(
        res,
        429,
        { error: "Too many requests. Try again in a few minutes." },
        { ...cors, "retry-after": "300" },
      );
      return;
    }
    try {
      const body = await readBody(req);
      const url = parseDailymotionUrl(body.url);
      if (!url) {
        writeJson(res, 400, { error: "Paste a valid HTTPS Dailymotion link." }, cors);
        return;
      }
      if (body.rightsConfirmed !== true) {
        writeJson(
          res,
          400,
          { error: "Confirm that you have permission to download this video." },
          cors,
        );
        return;
      }
      const job = createJob(url);
      if (!job) {
        writeJson(
          res,
          503,
          { error: "The converter is busy. Try again shortly." },
          { ...cors, "retry-after": "60" },
        );
        return;
      }
      writeJson(res, 202, publicJob(job), { ...cors, location: `/jobs/${job.id}` });
    } catch {
      writeJson(res, 400, { error: "Invalid request body." }, cors);
    }
    return;
  }

  const jobMatch = requestUrl.pathname.match(/^\/jobs\/([0-9a-f-]+)$/i);
  if (jobMatch && req.method === "GET") {
    const job = getJob(jobMatch[1]);
    if (!job) {
      writeJson(res, 404, { error: "Job not found or expired." }, cors);
      return;
    }
    writeJson(res, 200, publicJob(job), cors);
    return;
  }

  if (jobMatch && req.method === "DELETE") {
    const job = getJob(jobMatch[1]);
    if (!job) {
      writeJson(res, 404, { error: "Job not found or expired." }, cors);
      return;
    }
    if (["checking", "downloading", "converting"].includes(job.status)) {
      writeJson(res, 409, { error: "An active conversion cannot be deleted yet." }, cors);
      return;
    }
    await removeJob(job.id);
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const downloadMatch = requestUrl.pathname.match(/^\/jobs\/([0-9a-f-]+)\/download$/i);
  if (downloadMatch && req.method === "GET") {
    const job = getJob(downloadMatch[1]);
    if (!job || job.status !== "ready" || !job.outputPath) {
      writeJson(res, 404, { error: "File not ready or expired." }, cors);
      return;
    }
    const fileName = downloadName(job);
    res.writeHead(200, {
      ...cors,
      "content-type": "video/quicktime",
      "content-length": String(job.outputSize),
      "content-disposition": `attachment; filename="${basename(fileName)}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    createReadStream(job.outputPath)
      .on("error", () => res.destroy())
      .pipe(res);
    return;
  }

  writeJson(res, 404, { error: "Not found." }, cors);
});

server.requestTimeout = 30_000;
server.headersTimeout = 35_000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Dailymotion MOV backend listening on ${PORT}`);
});

async function shutdown() {
  server.close();
  await cleanupAll();
  process.exit(0);
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
