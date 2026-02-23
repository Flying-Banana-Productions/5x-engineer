import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type DebugTraceFn = (event: string, data?: unknown) => void;

function sanitizeData(data: unknown): Record<string, unknown> {
	if (data === undefined) return {};
	if (data === null) return { value: null };
	if (typeof data !== "object") return { value: data };

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		if (value instanceof Error) {
			out[key] = {
				name: value.name,
				message: value.message,
				stack: value.stack,
			};
			continue;
		}
		if (typeof value === "bigint") {
			out[key] = value.toString();
			continue;
		}
		out[key] = value;
	}
	return out;
}

export interface DebugTraceLogger {
	enabled: boolean;
	filePath?: string;
	trace: DebugTraceFn;
}

export function createDebugTraceLogger(opts: {
	enabled: boolean;
	projectRoot: string;
	command: string;
	label?: string;
}): DebugTraceLogger {
	if (!opts.enabled) {
		return {
			enabled: false,
			trace: () => {},
		};
	}

	const dir = join(opts.projectRoot, ".5x", "debug");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const suffix = opts.label ? `-${opts.label}` : "";
	const filePath = join(dir, `${opts.command}-${ts}${suffix}.ndjson`);

	const trace: DebugTraceFn = (event, data) => {
		const line = {
			ts: new Date().toISOString(),
			pid: process.pid,
			event,
			...sanitizeData(data),
		};
		try {
			appendFileSync(filePath, `${JSON.stringify(line)}\n`, "utf8");
		} catch {
			// Never fail command execution due to debug trace write errors.
		}
	};

	trace("debug_trace.enabled", { filePath, command: opts.command });

	return {
		enabled: true,
		filePath,
		trace,
	};
}
