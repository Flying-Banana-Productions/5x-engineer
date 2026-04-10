import type { z } from "zod";

import { FiveXConfigSchema } from "./config.js";

const DEPRECATED_KEYS = new Set(["maxAutoIterations", "maxReviewIterations"]);

export interface ConfigKeyMeta {
	key: string;
	type: string;
	default: unknown;
	description: string;
	deprecated?: boolean;
	/** Present for `z.enum` fields (e.g. delegationMode). */
	allowedValues?: string[];
}

function getTypeName(schema: z.ZodTypeAny): string {
	return (schema._def as { typeName?: string }).typeName ?? "unknown";
}

/**
 * Peel optional/default/nullable wrappers and collect the innermost schema plus
 * metadata used for registry entries.
 */
function peelWrappers(schema: z.ZodTypeAny): {
	inner: z.ZodTypeAny;
	defaultValue: unknown;
	optional: boolean;
	description: string;
} {
	let s = schema;
	let defaultValue: unknown;
	let optional = false;
	let description = "";

	while (true) {
		const def = s._def as {
			typeName?: string;
			description?: string;
			innerType?: z.ZodTypeAny;
			defaultValue?: () => unknown;
		};
		if (def.description) description = def.description;

		const t = def.typeName;
		if (t === "ZodOptional") {
			optional = true;
			const next = def.innerType;
			if (!next) break;
			s = next;
			continue;
		}
		if (t === "ZodNullable") {
			optional = true;
			const next = def.innerType;
			if (!next) break;
			s = next;
			continue;
		}
		if (t === "ZodDefault") {
			const factory = def.defaultValue;
			if (factory) defaultValue = factory();
			const next = def.innerType;
			if (!next) break;
			s = next;
			continue;
		}
		break;
	}

	return { inner: s, defaultValue, optional, description };
}

function resolveLeafType(inner: z.ZodTypeAny): {
	type: string;
	allowedValues?: string[];
} {
	const peeled = peelWrappers(inner);
	const core = peeled.inner;
	const t = getTypeName(core);

	if (t === "ZodString") return { type: "string" };
	if (t === "ZodNumber") return { type: "number" };
	if (t === "ZodBoolean") return { type: "boolean" };

	if (t === "ZodRecord") return { type: "record" };

	if (t === "ZodArray") {
		const elSchema = (core._def as { type: z.ZodTypeAny }).type;
		const el = resolveLeafType(elSchema);
		return { type: `${el.type}[]` };
	}

	if (t === "ZodEnum") {
		const values = (core._def as { values: unknown }).values;
		const allowedValues = Array.isArray(values)
			? [...values]
			: Object.values(values as Record<string, string>);
		return { type: "enum", allowedValues: allowedValues as string[] };
	}

	if (t === "ZodNativeEnum") {
		const vals = (core._def as { values: Record<string, string | number> })
			.values;
		const allowedValues = [
			...new Set(Object.values(vals).map((v) => String(v))),
		];
		return { type: "enum", allowedValues };
	}

	return { type: t.replace(/^Zod/, "").toLowerCase() || "unknown" };
}

function walk(
	schema: z.ZodTypeAny,
	prefix: string,
	out: ConfigKeyMeta[],
): void {
	const { inner, defaultValue, optional, description } = peelWrappers(schema);
	const t = getTypeName(inner);

	if (t === "ZodObject") {
		const shape = (inner as z.ZodObject<Record<string, z.ZodTypeAny>>).shape;
		for (const key of Object.keys(shape).sort()) {
			const path = prefix ? `${prefix}.${key}` : key;
			const fieldSchema = shape[key];
			if (fieldSchema) walk(fieldSchema, path, out);
		}
		return;
	}

	const { type, allowedValues } = resolveLeafType(inner);

	let effectiveDefault: unknown;
	if (optional && defaultValue === undefined) {
		effectiveDefault = undefined;
	} else {
		effectiveDefault = defaultValue;
	}

	const meta: ConfigKeyMeta = {
		key: prefix,
		type,
		default: effectiveDefault,
		description,
		...(allowedValues ? { allowedValues } : {}),
	};

	if (DEPRECATED_KEYS.has(prefix)) {
		meta.deprecated = true;
	}

	out.push(meta);
}

/**
 * Walk a Zod object schema and produce a flat list of leaf config keys with
 * types, defaults, and descriptions.
 */
export function buildConfigRegistry(
	schema: z.ZodObject<Record<string, z.ZodTypeAny>>,
): ConfigKeyMeta[] {
	const out: ConfigKeyMeta[] = [];
	walk(schema, "", out);
	return out;
}

let registryCache: ConfigKeyMeta[] | null = null;

/** Memoized flat registry for {@link FiveXConfigSchema} (known keys only; passthrough keys are omitted). */
export function getConfigRegistry(): ConfigKeyMeta[] {
	if (!registryCache) {
		registryCache = buildConfigRegistry(FiveXConfigSchema);
	}
	return registryCache;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively collect dotted keys from a nested plain object (arrays and scalars are leaves). */
function collectDottedKeys(
	value: unknown,
	prefix: string,
	out: Set<string>,
): void {
	if (!isPlainObject(value)) {
		if (prefix) out.add(prefix);
		return;
	}
	const keys = Object.keys(value);
	if (keys.length === 0) {
		if (prefix) out.add(prefix);
		return;
	}
	for (const k of keys) {
		const p = prefix ? `${prefix}.${k}` : k;
		const v = value[k];
		if (isPlainObject(v)) {
			collectDottedKeys(v, p, out);
		} else {
			out.add(p);
		}
	}
}

/**
 * Union of dotted keys present in any local overlay object (pre-merge parse).
 * Used for `isLocal` membership — no merge semantics.
 */
export function computeLocalKeys(
	localRaws: Record<string, unknown>[],
): Set<string> {
	const out = new Set<string>();
	for (const raw of localRaws) {
		collectDottedKeys(raw, "", out);
	}
	return out;
}
