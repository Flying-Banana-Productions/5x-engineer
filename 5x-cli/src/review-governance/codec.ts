import type {
	ImplementationDecisionPayload,
	ReviewDecisionPayload,
} from "./decisions.js";
import {
	validateImplementationDecision,
	validateReviewDecision,
} from "./decisions.js";

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

export function encodeImplementationDecisionPayload(
	payload: ImplementationDecisionPayload,
): unknown {
	return structuredClone(validateImplementationDecision(payload));
}

export function decodeImplementationDecisionPayload(
	raw: unknown,
): ImplementationDecisionPayload {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw new TypeError("implementation decision payload must be an object");
	return validateImplementationDecision(raw as ImplementationDecisionPayload);
}
