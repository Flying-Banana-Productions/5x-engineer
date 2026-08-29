/**
 * Shared timestamp helpers for SQLite `datetime('now')` values.
 *
 * SQLite stores `YYYY-MM-DD HH:MM:SS` (UTC, no zone). Treat that form as UTC
 * so age calculations are not skewed by the local timezone.
 */

/** Parse a run/invocation timestamp. Space-separated sqlite form is UTC. */
export function parseRunTimestamp(value: string): number {
	const trimmed = value.trim();
	if (!trimmed) return Number.NaN;
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)) {
		return Date.parse(`${trimmed.replace(" ", "T")}Z`);
	}
	return Date.parse(trimmed);
}
