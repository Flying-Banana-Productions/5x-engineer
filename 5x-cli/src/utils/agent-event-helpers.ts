/**
 * Shared helpers for escalation message building.
 *
 * Phase 4 simplification: the new AgentAdapter handles log streaming and
 * console output internally. No more free-text output parsing or onEvent
 * callbacks. This module is reduced to escalation reason formatting.
 */

/**
 * Build an escalation reason string that always includes the log path.
 *
 * In the new adapter model, there is no captured stdout to snippet — the
 * adapter streams events to a log file and optionally to console. The
 * escalation reason is the message plus a reference to the log file.
 */
export function buildEscalationReason(
	message: string,
	logPath?: string,
): string {
	if (logPath) {
		return `${message}\nLog: ${logPath}`;
	}
	return message;
}
