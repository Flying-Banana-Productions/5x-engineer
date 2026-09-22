import type { ReviewDecisionPayload } from "./decisions.js";
import { validateReviewDecision } from "./decisions.js";

export function encodeReviewDecisionPayload(
	payload: ReviewDecisionPayload,
): unknown {
	return structuredClone(validateReviewDecision(payload));
}

export function decodeReviewDecisionPayload(
	raw: unknown,
): ReviewDecisionPayload {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw new TypeError("review decision payload must be an object");
	return validateReviewDecision(raw as ReviewDecisionPayload);
}
