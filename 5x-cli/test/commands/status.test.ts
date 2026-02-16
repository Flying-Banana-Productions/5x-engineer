import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");
const PLAN_PATH = resolve(
  import.meta.dir,
  "../../../docs/development/001-impl-5x-cli.md"
);

async function runStatus(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", BIN, "status", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("5x status", () => {
  test("displays plan progress for real plan", async () => {
    const { stdout, exitCode } = await runStatus([PLAN_PATH]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("5x CLI");
    expect(stdout).toContain("Phase 1");
    expect(stdout).toContain("Phase 7");
    expect(stdout).toContain("Overall:");
  });

  test("shows 0% for all-unchecked plan", async () => {
    const { stdout } = await runStatus([PLAN_PATH]);
    expect(stdout).toContain("0%");
  });

  test("errors on missing file", async () => {
    const { stderr, exitCode } = await runStatus(["nonexistent.md"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not found");
  });
});
