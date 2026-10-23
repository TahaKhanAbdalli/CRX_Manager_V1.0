#!/usr/bin/env node
// Isolated, re-runnable proof for supabase/migrations/20261022086500_product_brands.sql.
//
// WHAT IT PROVES, in order:
//   1. on the real-shape harness (live helper bodies, Supabase-style default privileges) the
//      migration applies in one transaction and its postflight passes;
//   2. every behaviour test in fixtures/product-brands-tests.sql passes (B1-B11: admin add/edit,
//      replay, intent mismatch, name/EPA/field checks, versions, no direct writes, who can read);
//   3. re-applying it aborts in the preflight (PREFLIGHT_PRODUCT_BRANDS_TABLE_EXISTS), and the live
//      smoke chain (smoke-upsert-product-brand.sql) passes on the harness and leaves no rows;
//   4. mutation: a copy that grants authenticated INSERT aborts in the postflight and leaves no
//      table behind, so the postflight really guards the access it claims to.
//
// Runs on PostgreSQL 17 to match production. Requires Docker. Touches NOTHING outside its own
// throwaway container.
//
//   node scripts/smoke/prove-product-brands.mjs
//
// Exits 0 only if every phase passes.

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const CONTAINER = `crx-prove-product-brands-${RUN_ID}`;
const OWNER_LABEL = "crx.prover=product-brands";
const IMAGE = "postgres:17";

const MIGRATION = join(REPO, "supabase", "migrations", "20261022086500_product_brands.sql");
const HARNESS = join(HERE, "fixtures", "product-brands-harness.sql");
const TESTS = join(HERE, "fixtures", "product-brands-tests.sql");
const SMOKE_CHAIN = join(HERE, "smoke-upsert-product-brand.sql");
const TEST_IDS = [
  "B1", "B2", "B3", "B4a", "B4b", "B5a", "B5b", "B5c", "B5d", "B5e", "B5f","B6a", "B6b", "B6c", "B6d", "B6e", "B6f",
  "B7a", "B7b", "B7c", "B7d", "B7e", "B8a", "B8b", "B8c", "B8d", "B9a", "B9b", "B9c", "B9d", "B9e",
  "B10a", "B10b", "B10c", "B10d", "B11a", "B11b", "B12",
];

const log = (m) => process.stdout.write(`${m}\n`);
const docker = (args, opts = {}) => execFileSync("docker", args, { encoding: "utf8", stdio: "pipe", ...opts });

function psql(database, containerPath, { singleTransaction = false } = {}) {
  const args = ["exec", CONTAINER, "psql", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1", "-X", "-q"];
  if (singleTransaction) args.push("-1");
  args.push("-f", containerPath);
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function psqlCommand(database, sql) {
  const r = spawnSync("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-d", database, "-X", "-tA", "-c", sql],
    { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function copyIn(localPath, containerPath) {
  docker(["cp", localPath, `${CONTAINER}:${containerPath}`]);
}

function cleanup() {
  try { docker(["rm", "-f", CONTAINER], { stdio: "ignore" }); } catch { /* not running */ }
}

function fail(message, detail = "") {
  log(`FAIL: ${message}`);
  if (detail) log(detail);
  cleanup();
  process.exit(1);
}

function main() {
  docker(["run", "-d", "--rm", "--name", CONTAINER, "--label", OWNER_LABEL,
    "-e", "POSTGRES_PASSWORD=prove", IMAGE]);
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    ready = spawnSync("docker", ["exec", CONTAINER, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"]).status === 0;
    if (!ready) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  if (!ready) fail("postgres did not become ready");

  copyIn(HARNESS, "/tmp/harness.sql");
  copyIn(MIGRATION, "/tmp/migration.sql");
  copyIn(TESTS, "/tmp/tests.sql");

  // Phase 1: harness + migration in one transaction.
  const harness = psql("postgres", "/tmp/harness.sql");
  if (!harness.ok) fail("harness did not load", harness.out);
  const apply = psql("postgres", "/tmp/migration.sql", { singleTransaction: true });
  if (!apply.ok) fail("migration did not apply on the harness", apply.out);
  log("PASS phase 1: migration applied, postflight passed");

  // Phase 2: behaviour tests.
  const tests = psql("postgres", "/tmp/tests.sql");
  const passed = new Set([...tests.out.matchAll(/PASS (\S+)/g)].map((m) => m[1]));
  const missing = TEST_IDS.filter((id) => !passed.has(id));
  if (!tests.ok || missing.length > 0) fail(`behaviour tests failed (missing: ${missing.join(", ") || "none"})`, tests.out);
  log(`PASS phase 2: ${TEST_IDS.length} behaviour tests`);

  // Phase 3: re-apply aborts in the preflight.
  const reapply = psql("postgres", "/tmp/migration.sql", { singleTransaction: true });
  if (reapply.ok || !reapply.out.includes("PREFLIGHT_PRODUCT_BRANDS_TABLE_EXISTS")) {
    fail("re-applying did not abort in the preflight", reapply.out);
  }
  log("PASS phase 3: re-apply refused by the preflight");

  // Phase 3b: the live smoke chain runs green on the harness (it must end in SMOKE_PASS_ROLLBACK).
  copyIn(SMOKE_CHAIN, "/tmp/smoke.sql");
  const brandsBefore = psqlCommand("postgres", "SELECT count(*) FROM public.product_brands");
  const smoke = psql("postgres", "/tmp/smoke.sql");
  if (smoke.ok || !smoke.out.includes("SMOKE_PASS_ROLLBACK")) fail("the smoke chain did not pass", smoke.out);
  const brandsAfter = psqlCommand("postgres", "SELECT count(*) FROM public.product_brands");
  if (brandsAfter.out !== brandsBefore.out) fail("the smoke chain left rows behind", `${brandsBefore.out} -> ${brandsAfter.out}`);
  log("PASS phase 3b: smoke chain passed and rolled back");

  // Phase 4: a copy that over-grants aborts in the postflight and leaves nothing behind.
  const original = readFileSync(MIGRATION, "utf8");
  const grantLine = "GRANT SELECT ON TABLE public.product_brands TO authenticated;";
  if (!original.includes(grantLine)) fail("mutation anchor not found in the migration");
  const workDir = mkdtempSync(join(tmpdir(), "crx-prove-brands-"));
  const mutated = join(workDir, "mutated.sql");
  writeFileSync(mutated, original.replace(grantLine, "GRANT SELECT, INSERT ON TABLE public.product_brands TO authenticated;"));
  copyIn(mutated, "/tmp/mutated.sql");
  const createDb = psqlCommand("postgres", "CREATE DATABASE mutation");
  if (!createDb.ok) fail("could not create the mutation database", createDb.out);
  const harness2 = psql("mutation", "/tmp/harness.sql");
  if (!harness2.ok) fail("harness did not load into the mutation database", harness2.out);
  const mutatedApply = psql("mutation", "/tmp/mutated.sql", { singleTransaction: true });
  if (mutatedApply.ok || !mutatedApply.out.includes("PRODUCT_BRANDS_POSTFLIGHT: table privileges")) {
    fail("the over-granting copy was not refused by the postflight", mutatedApply.out);
  }
  const leftover = psqlCommand("mutation", "SELECT to_regclass('public.product_brands') IS NULL");
  if (leftover.out !== "t") fail("the refused apply left a product_brands table behind", leftover.out);
  rmSync(workDir, { recursive: true, force: true });
  log("PASS phase 4: over-granting copy refused by the postflight, nothing left behind");

  cleanup();
  log("ALL PHASES PASSED");
}

try {
  main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
