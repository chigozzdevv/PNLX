import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { run, runAsync } from "./artifact";

const deadlineEnv = (milliseconds: string) => ({ ...process.env, PNLX_NOIR_PROVER_TIMEOUT_MS: milliseconds });
const failure = 'process.stdout.write("SECRET-WITNESS\\n".repeat(100000)); process.stderr.write("SECRET-WITNESS"); process.exit(1)';
const stalled = 'setInterval(() => {}, 1000)';

describe("bounded Noir command execution", () => {
  test("sync failure never exposes witness-bearing child logs or arguments", () => {
    expect(() => run(process.execPath, ["-e", failure], process.cwd(), deadlineEnv("1000")))
      .toThrow("Noir prover command failed");
    try { run(process.execPath, ["-e", failure], process.cwd(), deadlineEnv("1000")); }
    catch (error) { expect((error as Error).message).not.toContain("SECRET-WITNESS"); }
  });

  test("async failure discards large output and returns a generic error", async () => {
    let message = "";
    try { await runAsync(process.execPath, ["-e", failure], process.cwd(), deadlineEnv("1000")); }
    catch (error) { message = (error as Error).message; }
    expect(message).toBe("Noir prover command failed");
    expect(message).not.toContain("SECRET-WITNESS");
  });

  test("sync and async stalled commands terminate at their configured deadlines", async () => {
    const start = Date.now();
    expect(() => run(process.execPath, ["-e", stalled], process.cwd(), deadlineEnv("25")))
      .toThrow("deadline exceeded");
    await expect(runAsync(process.execPath, ["-e", stalled], process.cwd(), deadlineEnv("25")))
      .rejects.toThrow("deadline exceeded");
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test("rejects unbounded or malformed deadline configuration without starting a command", async () => {
    for (const value of ["0", "-1", "1.5", "Infinity", "900001", "nonsense"]) {
      expect(() => run("must-not-start", [], process.cwd(), deadlineEnv(value))).toThrow("PNLX_NOIR_PROVER_TIMEOUT_MS");
      await expect(runAsync("must-not-start", [], process.cwd(), deadlineEnv(value)))
        .rejects.toThrow("PNLX_NOIR_PROVER_TIMEOUT_MS");
    }
  });

  test("successful commands complete and leave the event loop responsive", async () => {
    let ticked = false;
    const tick = setTimeout(() => { ticked = true; }, 0);
    await runAsync(process.execPath, ["-e", "setTimeout(() => process.exit(0), 20)"], process.cwd(), deadlineEnv("1000"));
    clearTimeout(tick);
    expect(ticked).toBe(true);
    expect(() => run(process.execPath, ["-e", "process.exit(0)"], process.cwd(), deadlineEnv("1000"))).not.toThrow();
  });
});

test("async timeout terminates prover descendants in the same process group", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "pnlx-noir-child-"));
  const pidPath = join(root, "descendant.pid");
  const script = `const {spawn}=require("node:child_process");
    const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
    require("node:fs").writeFileSync(${JSON.stringify(pidPath)},String(child.pid));
    setInterval(()=>{},1000);`;
  let pid: number | undefined;
  let alive = true;
  try {
    await expect(runAsync(process.execPath, ["-e", script], root, deadlineEnv("200")))
      .rejects.toThrow("deadline exceeded");
    pid = Number(readFileSync(pidPath, "utf8"));
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try { process.kill(pid, 0); }
      catch { alive = false; break; }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    expect(alive).toBe(false);
  } finally {
    if (pid && alive) { try { process.kill(pid, "SIGKILL"); } catch {} }
    rmSync(root, { recursive: true, force: true });
  }
});
