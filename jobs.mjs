import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  JOB_TTL_MS,
  MAX_DURATION_SECONDS,
  MAX_OUTPUT_BYTES,
  MAX_QUEUE,
} from "./config.mjs";

const jobs = new Map();
const queue = [];
let processing = false;

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => (current + chunk.toString()).slice(-1_000_000);
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
      options.onStdout?.(chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
      options.onStderr?.(chunk.toString());
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr.slice(-1600)}`));
    });
  });

const safeFileName = (value) => {
  const cleaned = String(value || "dailymotion-video")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9 _.-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 100);
  return cleaned || "dailymotion-video";
};

const friendlyError = (error) => {
  const message = String(error?.message || error);
  if (/Unsupported URL|not a valid URL|Invalid URL/i.test(message)) {
    return "That Dailymotion link is not supported.";
  }
  if (/Private video|login|authentication|password|cookies/i.test(message)) {
    return "This video is private or requires sign-in.";
  }
  if (/copyright|geo|country|region|not available/i.test(message)) {
    return "This video is restricted or unavailable in this region.";
  }
  if (/duration limit/i.test(message)) {
    return `Video is longer than the ${Math.floor(MAX_DURATION_SECONDS / 60)}-minute limit.`;
  }
  if (/File is larger|size limit|too large|max-filesize/i.test(message)) {
    return `Converted file is larger than the ${Math.floor(MAX_OUTPUT_BYTES / 1024 / 1024)} MB limit.`;
  }
  return "Conversion failed. Check that the video is public, then try again.";
};

const inspectVideo = async (url) => {
  const { stdout } = await run("yt-dlp", [
    "--dump-single-json",
    "--skip-download",
    "--no-playlist",
    "--no-warnings",
    "--socket-timeout",
    "20",
    url,
  ]);
  return JSON.parse(stdout);
};

const findDownloadedFile = async (directory) => {
  const names = await fs.readdir(directory);
  const name = names.find((entry) => entry.startsWith("source.") && !entry.endsWith(".part"));
  if (!name) throw new Error("download output missing");
  return join(directory, name);
};

const parsePercent = (text) => {
  const match = text.match(/DMOV_PROGRESS=\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  return Math.max(0, Math.min(100, Number(match[1])));
};

const convertJob = async (job) => {
  const directory = await fs.mkdtemp(join(tmpdir(), "dmov-"));
  job.workDir = directory;
  try {
    job.status = "checking";
    job.progress = 8;
    const metadata = await inspectVideo(job.url);
    const duration = Number(metadata.duration || 0);
    if (duration > MAX_DURATION_SECONDS) throw new Error("duration limit");
    job.title = String(metadata.title || "Dailymotion video").slice(0, 180);

    job.status = "downloading";
    job.progress = 18;
    let progressBuffer = "";
    await run("yt-dlp", [
      "--no-playlist",
      "--socket-timeout",
      "20",
      "--retries",
      "3",
      "--fragment-retries",
      "3",
      "--max-filesize",
      `${Math.floor(MAX_OUTPUT_BYTES / 1024 / 1024)}M`,
      "--format",
      "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
      "--merge-output-format",
      "mp4",
      "--newline",
      "--progress-template",
      "download:DMOV_PROGRESS=%(progress._percent_str)s",
      "--output",
      join(directory, "source.%(ext)s"),
      job.url,
    ], {
      onStdout(chunk) {
        progressBuffer = (progressBuffer + chunk).slice(-4000);
        const percent = parsePercent(progressBuffer);
        if (percent !== null) job.progress = 18 + Math.round(percent * 0.52);
      },
    });

    const source = await findDownloadedFile(directory);
    if ((await fs.stat(source)).size > MAX_OUTPUT_BYTES) throw new Error("size limit");

    job.status = "converting";
    job.progress = 74;
    const output = join(directory, "output.mov");
    try {
      await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", source,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c", "copy",
        "-movflags", "+faststart",
        "-f", "mov",
        output,
      ]);
    } catch {
      await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", source,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart",
        "-f", "mov",
        output,
      ]);
    }

    const outputStats = await fs.stat(output);
    if (outputStats.size > MAX_OUTPUT_BYTES) throw new Error("size limit");
    job.status = "ready";
    job.progress = 100;
    job.outputPath = output;
    job.outputSize = outputStats.size;
    job.expiresAt = Date.now() + JOB_TTL_MS;
  } catch (error) {
    console.error(`[job ${job.id}] ${String(error?.message || error).slice(-1200)}`);
    job.status = "failed";
    job.progress = 0;
    job.error = friendlyError(error);
    job.expiresAt = Date.now() + Math.min(JOB_TTL_MS, 10 * 60_000);
    await fs.rm(directory, { recursive: true, force: true });
    job.workDir = null;
  }
};

const drainQueue = async () => {
  if (processing) return;
  processing = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      const job = jobs.get(id);
      if (job?.status === "queued") await convertJob(job);
    }
  } finally {
    processing = false;
  }
};

export const queueStatus = () => ({ active: processing, queued: queue.length });
export const getJob = (id) => jobs.get(id);

export const publicJob = (job) => ({
  id: job.id,
  status: job.status,
  progress: job.progress,
  title: job.title,
  outputSize: job.outputSize,
  error: job.error,
  expiresAt: job.expiresAt ? new Date(job.expiresAt).toISOString() : null,
  downloadUrl: job.status === "ready" ? `/jobs/${job.id}/download` : null,
});

export function createJob(url) {
  if (queue.length >= MAX_QUEUE) return null;
  const id = randomUUID();
  const job = {
    id,
    url,
    status: "queued",
    progress: 2,
    title: null,
    outputPath: null,
    outputSize: null,
    workDir: null,
    error: null,
    createdAt: Date.now(),
    expiresAt: null,
  };
  jobs.set(id, job);
  queue.push(id);
  void drainQueue();
  return job;
}

export async function removeJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  if (job.workDir) await fs.rm(job.workDir, { recursive: true, force: true });
  jobs.delete(id);
}

export const downloadName = (job) => `${safeFileName(job.title)}.mov`;

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.expiresAt && job.expiresAt <= now) void removeJob(id);
  }
}, 60_000).unref();

export async function cleanupAll() {
  await Promise.all([...jobs.keys()].map((id) => removeJob(id)));
}
