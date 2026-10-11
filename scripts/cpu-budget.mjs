#!/usr/bin/env node
// CPU budget of the Worker's code paths on the Workers Free plan (SPEC 28.3, 28.7): 10 ms per request, queue
// invocation (assumed) and Workflow step. Bundles scripts/cpu-budget/paths.ts with esbuild from the repo
// sources, then runs every path once in each of 5 fresh Node processes ("cold": first call in the process,
// zod in jitless mode as in workerd, the ICU collator built at module scope) and reports the median CPU time
// from process.cpuUsage(). Cloudflare bindings are in-memory fakes, so this is DataTrust's own CPU.
//   npm run budget:cpu                    print the table
//   npm run budget:cpu -- --gate 8        also exit 1 when any median is above 8 ms (CI)
//   npm run budget:cpu -- --json out.json write the medians and samples
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const gate = opt('--gate') === undefined ? null : Number(opt('--gate'));
const runs = Number(opt('--runs') ?? 5);
const out = mkdtempSync(join(tmpdir(), 'datatrust-cpu-'));

try {
  const bundle = join(out, 'paths.mjs');
  await build({
    entryPoints: [join(root, 'scripts/cpu-budget/paths.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: bundle,
    logLevel: 'warning',
    // Workflow classes are not measured; nothing here imports cloudflare:* at run time.
    external: ['cloudflare:*'],
  });
  const child = join(out, 'child.mjs');
  writeFileSync(
    child,
    `const thread = typeof process.threadCpuUsage === 'function' ? () => process.threadCpuUsage() : null;
const ms = (a, b) => (b.user - a.user + b.system - a.system) / 1000;
const s0 = thread?.();
// Module scope (zod schemas, the collator, the router and parser warm-up) is Worker start-up (1 s limit).
const { paths } = await import(${JSON.stringify(bundle)});
const s1 = thread?.();
const run = await paths[process.argv[2]].prepare();
// threadMs: the main thread only (Node >= 23.9), like workerd, which charges a request its own thread's CPU.
// processMs: every thread, which also counts V8's background compiler and GC; reported for reference.
const p0 = process.cpuUsage();
const t0 = thread?.();
await run();
const t1 = thread?.();
const p1 = process.cpuUsage(p0);
process.stdout.write(
  JSON.stringify({
    threadMs: t0 ? ms(t0, t1) : null,
    processMs: (p1.user + p1.system) / 1000,
    startupMs: s0 ? ms(s0, s1) : null,
  }),
);
`,
  );
  const { paths } = await import(bundle);
  const results = [];
  for (const name of Object.keys(paths)) {
    const samples = [];
    for (let i = 0; i < runs; i++) {
      const p = spawnSync(process.execPath, [child, name], { encoding: 'utf8' });
      if (p.status !== 0) {
        console.error(`${name}: ${p.stderr.trim().split('\n').slice(-5).join('\n')}`);
        process.exit(2);
      }
      samples.push(JSON.parse(p.stdout));
    }
    // Gate on the main thread's CPU; Node versions without threadCpuUsage fall back to the process total.
    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const metric = samples[0].threadMs === null ? 'processMs' : 'threadMs';
    results.push({
      path: name,
      medianMs: median(samples.map((x) => x[metric])),
      metric,
      processMedianMs: median(samples.map((x) => x.processMs)),
      startupMedianMs: samples[0].startupMs === null ? null : median(samples.map((x) => x.startupMs)),
      samplesMs: samples.map((x) => x[metric]),
    });
  }
  const width = Math.max(...results.map((r) => r.path.length));
  const metric = results[0].metric === 'threadMs' ? 'main-thread CPU' : 'process CPU (no threadCpuUsage in this Node)';
  console.log(
    `${metric} per cold invocation, median of ${runs} processes (Node ${process.version}, ${process.arch}); Free plan limit 10 ms`,
  );
  for (const r of results) {
    const flag = gate !== null && r.medianMs > gate ? '  OVER GATE' : '';
    console.log(`${r.path.padEnd(width)}  ${r.medianMs.toFixed(2).padStart(6)} ms${flag}`);
  }
  const startup = results.map((r) => r.startupMedianMs).filter((x) => x !== null);
  if (startup.length) {
    console.log(`${'start-up: module scope incl. warm-up (1 s limit)'.padEnd(width)}  ${Math.max(...startup).toFixed(2).padStart(6)} ms`);
  }
  if (opt('--json')) {
    writeFileSync(
      opt('--json'),
      JSON.stringify({ node: process.version, arch: process.arch, runs, gateMs: gate, results }, null, 1) + '\n',
    );
  }
  const over = gate === null ? [] : results.filter((r) => r.medianMs > gate);
  if (over.length) {
    console.error(`${over.length} path(s) above the ${gate} ms gate`);
    process.exitCode = 1;
  } else if (gate !== null) {
    console.log(`all medians within the ${gate} ms gate`);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
