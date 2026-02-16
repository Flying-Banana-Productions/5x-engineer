import { parse as parseYaml } from "yaml";

export interface VerdictBlock {
  protocolVersion: 1;
  readiness: "ready" | "ready_with_corrections" | "not_ready";
  reviewPath: string;
  items: VerdictItem[];
}

export interface VerdictItem {
  id: string;
  title: string;
  action: "auto_fix" | "human_required";
  reason: string;
}

export interface StatusBlock {
  protocolVersion: 1;
  result: "completed" | "needs_human" | "failed";
  planPath?: string;
  reviewPath?: string;
  commit?: string;
  phase?: number;
  summary?: string;
  reason?: string;
  context?: string;
  blockedOn?: string;
}

const VERDICT_RE = /<!--\s*5x:verdict\s*\n([\s\S]*?)-->/g;
const STATUS_RE = /<!--\s*5x:status\s*\n([\s\S]*?)-->/g;

/**
 * Extract the last matching block from text.
 * Returns the YAML content string, or null if no block found.
 */
function extractLastBlock(text: string, regex: RegExp): string | null {
  let lastMatch: string | null = null;
  // Reset regex state
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    lastMatch = match[1] ?? null;
  }
  return lastMatch;
}

/**
 * Parse a 5x:verdict block from text (typically a review markdown file).
 * Returns the last verdict block found, or null if missing/malformed.
 * Never throws.
 */
export function parseVerdictBlock(text: string): VerdictBlock | null {
  const yamlStr = extractLastBlock(text, VERDICT_RE);
  if (!yamlStr) return null;

  try {
    const parsed = parseYaml(yamlStr);
    if (!parsed || typeof parsed !== "object") return null;

    const { protocolVersion, readiness, reviewPath, items } = parsed as Record<string, unknown>;

    if (protocolVersion !== undefined && protocolVersion !== 1) {
      // Warn on unknown version but still attempt parse
      console.warn(`[5x] Unknown verdict protocolVersion: ${protocolVersion}`);
    }

    // Validate required fields
    if (!readiness || typeof readiness !== "string") return null;
    if (!reviewPath || typeof reviewPath !== "string") return null;
    if (!Array.isArray(items)) return null;

    const validReadiness = ["ready", "ready_with_corrections", "not_ready"];
    if (!validReadiness.includes(readiness)) return null;

    const parsedItems: VerdictItem[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const { id, title, action, reason } = item as Record<string, unknown>;
      if (typeof id !== "string" || typeof title !== "string") continue;
      if (action !== "auto_fix" && action !== "human_required") continue;
      parsedItems.push({
        id: id,
        title: title,
        action: action,
        reason: typeof reason === "string" ? reason : "",
      });
    }

    return {
      protocolVersion: 1,
      readiness: readiness as VerdictBlock["readiness"],
      reviewPath: reviewPath as string,
      items: parsedItems,
    };
  } catch {
    // Malformed YAML — treat as missing
    return null;
  }
}

/**
 * Parse a 5x:status block from text (typically agent stdout).
 * Returns the last status block found, or null if missing/malformed.
 * Never throws.
 */
export function parseStatusBlock(text: string): StatusBlock | null {
  const yamlStr = extractLastBlock(text, STATUS_RE);
  if (!yamlStr) return null;

  try {
    const parsed = parseYaml(yamlStr);
    if (!parsed || typeof parsed !== "object") return null;

    const data = parsed as Record<string, unknown>;

    if (data.protocolVersion !== undefined && data.protocolVersion !== 1) {
      console.warn(`[5x] Unknown status protocolVersion: ${data.protocolVersion}`);
    }

    // Validate required field
    const validResults = ["completed", "needs_human", "failed"];
    if (!data.result || typeof data.result !== "string" || !validResults.includes(data.result)) {
      return null;
    }

    return {
      protocolVersion: 1,
      result: data.result as StatusBlock["result"],
      planPath: typeof data.planPath === "string" ? data.planPath : undefined,
      reviewPath: typeof data.reviewPath === "string" ? data.reviewPath : undefined,
      commit: typeof data.commit === "string" ? data.commit : undefined,
      phase: typeof data.phase === "number" ? data.phase : undefined,
      summary: typeof data.summary === "string" ? data.summary : undefined,
      reason: typeof data.reason === "string" ? data.reason : undefined,
      context: typeof data.context === "string" ? data.context : undefined,
      blockedOn: typeof data.blockedOn === "string" ? data.blockedOn : undefined,
    };
  } catch {
    // Malformed YAML — treat as missing
    return null;
  }
}
