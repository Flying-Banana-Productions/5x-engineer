/**
 * Structured audit record writer.
 *
 * Appends compact JSON records (base64url-encoded) as HTML comments to review
 * files. This provides an audit trail that survives DB resets. The DB remains
 * the source of truth for orchestration decisions; this is for auditability.
 *
 * Format:  <!-- 5x:structured:v1 <base64url(JSON)> -->
 */

import { appendFile } from "node:fs/promises";

/**
 * Append a structured audit record to a file.
 *
 * The record object is JSON-serialized and base64url-encoded before embedding
 * in an HTML comment. This prevents `-->` or `--` sequences in string fields
 * from breaking the comment delimiter.
 *
 * @param filePath — path to the review or artifact file (append-only)
 * @param record — structured record object (e.g. verdict, status result)
 */
export async function appendStructuredAuditRecord(
	filePath: string,
	record: object,
): Promise<void> {
	const encoded = Buffer.from(JSON.stringify(record)).toString("base64url");
	const line = `\n<!-- 5x:structured:v1 ${encoded} -->\n`;
	await appendFile(filePath, line, "utf-8");
}
