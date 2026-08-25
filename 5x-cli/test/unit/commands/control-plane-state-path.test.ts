/**
 * Tests for control-plane state-file / DB path construction.
 *
 * Relative `stateDir` joins under `controlPlaneRoot`. Absolute `stateDir`
 * (configured `db.path`) is the state root and is not prefixed.
 */

import { describe, expect, test } from "bun:test";
import { isAbsolute, join } from "node:path";
import {
	controlPlaneDbPath,
	controlPlaneStatePath,
	DB_FILENAME,
} from "../../../src/commands/control-plane.js";

const ROOT = "/repo";
const REL = ".5x";
const ABS = "/var/lib/project-state";

describe("controlPlaneStatePath", () => {
	test("relative stateDir joins under controlPlaneRoot", () => {
		expect(controlPlaneStatePath(ROOT, REL, "current-run")).toBe(
			join(ROOT, REL, "current-run"),
		);
	});

	test("absolute stateDir is the state root and is not prefixed with controlPlaneRoot", () => {
		const result = controlPlaneStatePath(ROOT, ABS, "current-run");
		expect(result).toBe(join(ABS, "current-run"));
		expect(isAbsolute(result)).toBe(true);
		expect(result).not.toBe(join(ROOT, ABS, "current-run"));
		expect(result.startsWith(`${ROOT}/`)).toBe(false);
	});
});

describe("controlPlaneDbPath", () => {
	test("uses DB_FILENAME under relative stateDir", () => {
		expect(controlPlaneDbPath(ROOT, REL)).toBe(join(ROOT, REL, DB_FILENAME));
	});

	test("uses DB_FILENAME under absolute stateDir without prefixing controlPlaneRoot", () => {
		const result = controlPlaneDbPath(ROOT, ABS);
		expect(result).toBe(join(ABS, DB_FILENAME));
		expect(result).not.toBe(join(ROOT, ABS, DB_FILENAME));
	});
});
