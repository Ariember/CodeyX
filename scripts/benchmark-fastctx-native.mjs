import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runFile = promisify(execFile);
const modes = ["native"];
const modeArgument = { native: "--codey-fastctx-native" };
const tokenBudget = "32768";

export function summarize(samples) {
  assert.ok(samples.length > 0, "No timing samples");
  assert.ok(samples.every(value => Number.isFinite(value) && value >= 0), "Invalid timing sample");
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = value => sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)];
  const sum = samples.reduce((total, value) => total + value, 0);
  return {
    count: samples.length,
    minMs: sorted[0],
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: sorted.at(-1),
    meanMs: sum / samples.length,
    serialCallsPerSecond: sum === 0 ? null : samples.length * 1000 / sum,
  };
}

export function parseArguments(args) {
  const options = {
    binary: join(root, "target", "native-fastctx-benchmark", "release", `codey-fastctx${process.platform === "win32" ? ".exe" : ""}`),
    output: join(root, "output", "fastctx-native-benchmark"),
    samples: 100,
    rounds: 3,
    warmup: 10,
    coldSamples: 20,
    concurrencies: [1, 4, 16, 32, 64],
  };
  const keys = { "--binary": "binary", "--output": "output", "--samples": "samples", "--rounds": "rounds", "--warmup": "warmup", "--cold-samples": "coldSamples", "--concurrencies": "concurrencies" };
  for (let index = 0; index < args.length; index += 1) {
    const key = keys[args[index]];
    assert.ok(key && args[index + 1], `Unknown or missing benchmark argument: ${args[index]}`);
    const value = args[++index];
    if (key === "binary" || key === "output") options[key] = resolve(value);
    else if (key === "concurrencies") {
      options[key] = value.split(",").map(Number);
      assert.ok(options[key].every(value => Number.isSafeInteger(value) && value > 0 && value <= 256), "concurrencies must contain integers from 1 to 256");
      assert.equal(new Set(options[key]).size, options[key].length, "concurrencies must be unique");
    } else {
      options[key] = Number(value);
      assert.ok(Number.isSafeInteger(options[key]) && options[key] > 0, `${key} must be a positive integer`);
    }
  }
  return options;
}

export async function runConcurrent(count, concurrency, call, expected) {
  assert.ok(Number.isSafeInteger(count) && count > 0, "count must be a positive integer");
  assert.ok(Number.isSafeInteger(concurrency) && concurrency > 0, "concurrency must be a positive integer");
  const samples = new Array(count);
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (next < count) {
      const iteration = next++;
      const callStarted = performance.now();
      let durationMs;
      let errorKind = null;
      try {
        const result = await call(iteration);
        durationMs = performance.now() - callStarted;
        if (result?.isError === true) errorKind = "tool";
        else {
          try { assert.deepEqual(result, expected); }
          catch { errorKind = "equivalence"; }
        }
      } catch (error) {
        durationMs = performance.now() - callStarted;
        errorKind = error?.code === "BENCHMARK_TIMEOUT" ? "timeout" : "protocol";
      }
      samples[iteration] = { iteration, durationMs, errorKind };
    }
  }));
  const elapsedMs = performance.now() - started;
  const successCount = samples.filter(sample => sample.errorKind === null).length;
  return {
    elapsedMs, samples, successCount, errorCount: count - successCount,
    timeoutCount: samples.filter(sample => sample.errorKind === "timeout").length,
    equivalenceErrorCount: samples.filter(sample => sample.errorKind === "equivalence").length,
    callsPerSecond: elapsedMs === 0 ? null : successCount * 1000 / elapsedMs,
    attemptedCallsPerSecond: elapsedMs === 0 ? null : count * 1000 / elapsedMs,
  };
}

export function summarizeRuns(runs) {
  const samples = runs.flatMap(run => run.samples);
  const elapsedMs = runs.reduce((sum, run) => sum + run.elapsedMs, 0);
  const count = key => runs.reduce((sum, run) => sum + run[key], 0);
  const { serialCallsPerSecond: _serialCallsPerSecond, ...latency } = summarize(samples.map(sample => sample.durationMs));
  return {
    ...latency,
    successCount: count("successCount"), errorCount: count("errorCount"),
    timeoutCount: count("timeoutCount"), equivalenceErrorCount: count("equivalenceErrorCount"),
    elapsedMs,
    callsPerSecond: elapsedMs === 0 ? null : count("successCount") * 1000 / elapsedMs,
    attemptedCallsPerSecond: elapsedMs === 0 ? null : samples.length * 1000 / elapsedMs,
  };
}

class Worker {
  constructor(binary, mode, cwd, isolatedHome) {
    this.mode = mode;
    this.nextId = 0;
    this.pending = new Map();
    this.stderr = "";
    this.child = spawn(binary, [modeArgument[mode]], {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        CODEX_HOME: join(isolatedHome, ".codex"),
        CODEY_APP_STATE_DIR: join(isolatedHome, "codey-state"),
        FASTCTX_TOKEN_BUDGET: tokenBudget,
        FASTCTX_READ_TOKEN_BUDGET: tokenBudget,
        FASTCTX_GREP_TOKEN_BUDGET: tokenBudget,
        FASTCTX_GLOB_TOKEN_BUDGET: tokenBudget,
        NO_PROXY: "127.0.0.1,localhost,::1",
      },
    });
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-8192); });
    this.child.stdin.on("error", error => this.fail(error));
    this.child.on("error", error => this.fail(error));
    this.child.on("exit", (code, signal) => {
      this.fail(new Error(`${mode} worker exited (${code ?? signal}): ${this.stderr}`));
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(new Error(`${mode} worker returned non-JSON output`)); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${mode} protocol error: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
    });
  }

  fail(error) {
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params, notification = false) {
    if (this.failure) return Promise.reject(this.failure);
    const id = `${this.mode}-${++this.nextId}`;
    const request = { ...(notification ? {} : { id }), method, params };
    if (notification) { this.child.stdin.write(`${JSON.stringify(request)}\n`); return; }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`${this.mode} ${method} timed out`);
        error.code = "BENCHMARK_TIMEOUT";
        reject(error);
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  async ready() {
    return this.send("tools/list", {});
  }

  call(scenario) {
    return this.send("tools/call", { name: scenario.tool, arguments: scenario.arguments });
  }

  async close() {
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const timer = setTimeout(() => this.child.kill(), 5000);
      await once(this.child, "close");
      clearTimeout(timer);
    }
    this.lines.close();
  }
}

async function dataset(directory) {
  const data = join(directory, "中文数据");
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "small.txt"), "alpha\nbeta 世界\nthird line\n");
  await writeFile(join(data, "large.txt"), Array.from({ length: 700 }, (_, index) => `row ${String(index).padStart(4, "0")} ${"a reproducible large response ".repeat(2)}`).join("\n") + "\n");
  const corpus = join(data, "corpus");
  const rows = Array.from({ length: 100 }, (_, index) => `line ${index} ${index % 25 === 0 ? "needle-rare" : "ordinary"} fixed deterministic search data\n`).join("");
  for (let group = 0; group < 10; group += 1) {
    const folder = join(corpus, `group-${group}`);
    await mkdir(folder, { recursive: true });
    await Promise.all(Array.from({ length: 40 }, (_, index) => writeFile(join(folder, `file-${String(index).padStart(2, "0")}.txt`), rows)));
  }
  return [
    { name: "read-small", tool: "inspect_local_file", arguments: { file_path: join(data, "small.txt") } },
    { name: "read-large", tool: "inspect_local_file", arguments: { file_path: join(data, "large.txt") } },
    { name: "grep-tree", tool: "grep", arguments: { pattern: "needle-rare", path: corpus, output_mode: "summary" } },
    { name: "glob-tree", tool: "glob", arguments: { pattern: ["**/*.txt"], path: corpus, limit: 1000 } },
  ];
}

async function resources(workers) {
  if (process.platform !== "win32") return { available: false, reason: "This benchmark samples process resources only on Windows." };
  const ids = modes.map(mode => workers[mode].child.pid);
  if (!ids.every(id => Number.isSafeInteger(id) && id > 0)) return { available: false, reason: "Worker PID unavailable." };
  try {
    const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", [
      "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)",
      "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
      "chcp 65001 > $null",
      `$result = @(Get-Process -Id ${ids.join(",")} -ErrorAction Stop | ForEach-Object { [PSCustomObject]@{ pid = $_.Id; cpuMs = $_.TotalProcessorTime.TotalMilliseconds; workingSetBytes = $_.WorkingSet64; privateBytes = $_.PrivateMemorySize64; peakWorkingSetBytes = $_.PeakWorkingSet64 } })`,
      "$result | ConvertTo-Json -Compress",
    ].join("\n")], { windowsHide: true, encoding: "utf8", timeout: 15_000 });
    const parsed = JSON.parse(stdout);
    const snapshots = Array.isArray(parsed) ? parsed : [parsed];
    return { available: true, ...Object.fromEntries(modes.map(mode => [mode, snapshots.find(value => value.pid === workers[mode].child.pid)])) };
  } catch (error) {
    return { available: false, reason: `Process resource sampling failed: ${error.code ?? error.name}` };
  }
}

function formatReport(report) {
  const number = (value, digits = 3) => value === null ? "n/a" : value.toFixed(digits);
  const lines = [
    "# FastCtx native transport benchmark", "",
    "This measures one native worker through direct stdio. It excludes Desktop dispatch, the Codey HTTP bridge, and model latency.", "",
    ...modes.map(mode => `- ${mode} binary: ${report.environment.binaries[mode].path}; SHA-256: ${report.environment.binaries[mode].sha256}`),
    `- Build: ${report.environment.buildProfile}; platform: ${report.environment.platform}; Node: ${report.environment.node}`,
    `- Correctness: ${report.valid ? "all timed calls succeeded with equivalent outputs" : "FAILED; errors invalidate performance winner claims"}.`,
    `- Warm samples: ${report.options.rounds} rounds × ${report.options.samples} calls per scenario, concurrency, and mode; concurrency levels: ${report.options.concurrencies.join(", ")}; serial warmup: ${report.options.warmup}.`,
    `- Cold samples per mode: ${report.options.coldSamples}. Cold means process startup to tools/list plus first small read; filesystem cache is not flushed.`,
    "- An isolated official-provider configuration and 32768-token budgets are used. Scenario outputs are checked against the initial native result during warmup and sampling.",
    "- Each batch keeps up to the requested concurrency in flight; latency includes server queueing. Concurrency order reverses on alternate rounds.",
    "- All attempts, including errors and timeouts, are included in latency percentiles. Calls/s counts successful, output-equivalent calls divided by batch wall time, including harness output validation; errors are never treated as successful throughput.", "",
    "| Scenario | Concurrency | Native p50 / p95 / p99 ms | Native calls/s | Errors / timeouts |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const scenario of report.summary) {
    const { native } = scenario;
    const latency = value => [value.p50Ms, value.p95Ms, value.p99Ms].map(value => number(value)).join(" / ");
    lines.push(`| ${scenario.name} | ${scenario.concurrency} | ${latency(native)} | ${number(native.callsPerSecond, 1)} | ${native.errorCount} / ${native.timeoutCount} |`);
  }
  lines.push("", `Cold start p50: native ${report.cold.summary.native.p50Ms.toFixed(3)} ms.`, "", "Process resources cover only the directly spawned native worker PID, excluding this Node harness and all Desktop/bridge processes. The worker is sampled before and after its timed batch. Resident/private memory snapshots are not continuous memory peaks; peak working set is cumulative since worker startup.");
  const measuredResources = report.resources.filter(value => value.before.available && value.after.available);
  if (measuredResources.length > 0) {
    lines.push("", "| Mode | Concurrency | CPU ms per timed call | End resident MiB (mean) | End private commit MiB (mean) |", "| --- | ---: | ---: | ---: | ---: |");
    for (const mode of modes) {
      for (const concurrency of report.options.concurrencies) {
        const observations = measuredResources.filter(value => value.mode === mode && value.concurrency === concurrency);
        if (observations.length === 0) continue;
        const cpuMs = observations.reduce((sum, value) => sum + value.after[mode].cpuMs - value.before[mode].cpuMs, 0);
        const meanBytes = key => observations.reduce((sum, value) => sum + value.after[mode][key], 0) / observations.length / 1024 ** 2;
        lines.push(`| ${mode} | ${concurrency} | ${(cpuMs / observations.length / report.options.samples).toFixed(3)} | ${meanBytes("workingSetBytes").toFixed(2)} | ${meanBytes("privateBytes").toFixed(2)} |`);
      }
    }
  } else lines.push("", "Resource sampling unavailable; inspect results.json for the reason.");
  lines.push("");
  return lines.join("\n");
}

export async function runBenchmark(options) {
  options = { ...options, concurrencies: options.concurrencies ?? [1] };
  const binaries = { native: options.binary };
  const temporary = await mkdtemp(join(tmpdir(), "codey-fastctx-benchmark-"));
  const isolatedHome = join(temporary, "isolated-home");
  await mkdir(join(isolatedHome, ".codex"), { recursive: true });
  await writeFile(join(isolatedHome, ".codex", "config.toml"), 'model_provider = "openai"\n');
  const scenarios = await dataset(temporary);
  const samples = [];
  const runs = [];
  const roundResources = [];
  const cold = { native: [] };
  const equality = [];
  try {
    for (let index = 0; index < options.coldSamples; index += 1) {
      for (const mode of index % 2 === 0 ? modes : [...modes].reverse()) {
        const started = performance.now();
        const worker = new Worker(binaries[mode], mode, temporary, isolatedHome);
        try {
          await worker.ready();
          const result = await worker.call(scenarios[0]);
          cold[mode].push(performance.now() - started);
          assert.equal(result.isError, false);
        } finally { await worker.close(); }
      }
    }
    for (let round = 0; round < options.rounds; round += 1) {
      const workers = {};
      try {
        const definitions = {};
        for (const mode of round % 2 === 0 ? modes : [...modes].reverse()) {
          workers[mode] = new Worker(binaries[mode], mode, temporary, isolatedHome);
          definitions[mode] = await workers[mode].ready();
        }
        assert.deepEqual(definitions.native.tools.map(tool => tool.name).sort(), ["create_file", "delete", "glob", "grep", "inspect_local_file", "move", "replace"]);
        const expected = new Map();
        for (const scenario of scenarios) {
          const baseline = await workers.native.call(scenario);
          assert.equal(baseline.isError, false, `${scenario.name}: native tool failed`);
          const serialized = JSON.stringify(baseline);
          expected.set(scenario.name, baseline);
          equality.push({ round, scenario: scenario.name, responseBytes: Buffer.byteLength(serialized), sha256: createHash("sha256").update(serialized).digest("hex") });
          for (let warmup = 0; warmup < options.warmup; warmup += 1) {
            for (const mode of modes) assert.deepEqual(await workers[mode].call(scenario), baseline);
          }
        }
        for (const scenario of scenarios) {
          const levels = round % 2 === 0 ? options.concurrencies : [...options.concurrencies].reverse();
          for (const [level, concurrency] of levels.entries()) {
            for (const mode of (round + level) % 2 === 0 ? modes : [...modes].reverse()) {
              const before = await resources(workers);
              const measured = await runConcurrent(options.samples, concurrency, () => workers[mode].call(scenario), expected.get(scenario.name));
              const context = { round, scenario: scenario.name, mode, concurrency };
              samples.push(...measured.samples.map(sample => ({ ...context, ...sample })));
              runs.push({ ...context, ...measured });
              roundResources.push({ ...context, timedCalls: options.samples, before, after: await resources(workers) });
            }
          }
        }
      } finally { await Promise.all(Object.values(workers).map(worker => worker.close())); }
    }
    const summary = scenarios.flatMap(scenario => options.concurrencies.map(concurrency => {
      const byMode = Object.fromEntries(modes.map(mode => [mode, summarizeRuns(runs.filter(run => run.mode === mode && run.scenario === scenario.name && run.concurrency === concurrency))]));
      return { name: scenario.name, concurrency, ...byMode };
    }));
    const binaryMetadata = Object.fromEntries(await Promise.all(modes.map(async mode => [mode, { path: binaries[mode], sha256: createHash("sha256").update(await readFile(binaries[mode])).digest("hex") }])));
    const report = {
      measuredAt: new Date().toISOString(),
      scope: "Single-worker Rust sidecar native stdio round-trip; excludes Desktop, Codey bridge and model overhead.",
      environment: { platform: `${process.platform} ${process.arch} ${release()}`, node: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), buildProfile: /[\\/]release[\\/]/.test(options.binary) ? "release" : "non-release (validation only)", binary: options.binary, binarySha256: binaryMetadata.native.sha256, binaries: binaryMetadata, tokenBudget: Number(tokenBudget) },
      options,
      dataset: { files: 402, corpusFiles: 400, corpusLinesPerFile: 100, largeReadLines: 700, deterministic: true, filesystemCacheFlushed: false },
      equality,
      valid: summary.every(value => modes.every(mode => value[mode].errorCount === 0)),
      summary,
      cold: { samples: cold, summary: { native: summarize(cold.native) } },
      resources: roundResources,
      batches: runs.map(({ samples: _samples, ...run }) => run),
      samples,
    };
    await mkdir(options.output, { recursive: true });
    await writeFile(join(options.output, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(options.output, "report.md"), formatReport(report));
    return report;
  } finally {
    assert.equal(dirname(temporary), resolve(tmpdir()));
    assert.ok(basename(temporary).startsWith("codey-fastctx-benchmark-"));
    await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runBenchmark(parseArguments(process.argv.slice(2)));
  console.log(formatReport(report));
  console.log(`Raw samples: ${join(report.options.output, "results.json")}`);
}
