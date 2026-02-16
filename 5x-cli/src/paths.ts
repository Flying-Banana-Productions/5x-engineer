import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export function canonicalizePlanPath(rawPath: string): string {
	const abs = resolve(rawPath);
	try {
		return realpathSync(abs);
	} catch {
		return abs;
	}
}
