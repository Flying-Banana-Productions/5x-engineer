import {
	listBaseSkillNames,
	renderAllSkillTemplates,
} from "../../skills/loader.js";
import { createRenderContext } from "../../skills/renderer.js";
import {
	assetsOfKind,
	installSkillFiles,
	uninstallSkillFiles,
} from "../installer.js";
import { universalLocationResolver } from "../locations.js";
import type {
	HarnessDescription,
	HarnessInstallContext,
	HarnessInstallResult,
	HarnessPlugin,
	HarnessScope,
	HarnessUninstallContext,
	HarnessUninstallResult,
	RenderedAsset,
} from "../types.js";

/**
 * Render every managed universal asset for this context without writing.
 *
 * Skills only — the universal harness has no native subagents, so delegation
 * always goes through `5x invoke` and no per-role model is ever baked. Its
 * manifest fingerprint therefore varies only with the CLI version: a universal
 * install can go stale on `5x upgrade` and on nothing else.
 */
async function renderUniversalAssets(
	_ctx: HarnessInstallContext,
): Promise<RenderedAsset[]> {
	return renderAllSkillTemplates(createRenderContext(false)).map((skill) => ({
		kind: "skill" as const,
		name: skill.name,
		path: `skills/${skill.name}/SKILL.md`,
		content: skill.content,
	}));
}

const universalPlugin: HarnessPlugin = {
	name: "universal",
	description:
		"Install 5x skills for any AI coding tool (uses 5x invoke for delegation)",
	supportedScopes: ["project", "user"],

	locations: universalLocationResolver,

	describe(scope?: HarnessScope): HarnessDescription {
		const description: HarnessDescription = {
			skillNames: listBaseSkillNames(),
			agentNames: [],
		};

		if (scope) {
			return {
				...description,
				ruleNames: [],
				capabilities: { rules: false },
			};
		}

		return description;
	},

	renderAssets: renderUniversalAssets,

	async install(ctx: HarnessInstallContext): Promise<HarnessInstallResult> {
		const locations = universalLocationResolver.resolve(
			ctx.scope,
			ctx.projectRoot,
			ctx.homeDir,
		);

		// Install is a thin writer over the one render path.
		const rendered = await renderUniversalAssets(ctx);
		return {
			skills: installSkillFiles(
				locations.skillsDir,
				assetsOfKind(rendered, "skill"),
				ctx.force,
			),
			agents: { created: [], overwritten: [], skipped: [] },
		};
	},

	async uninstall(
		ctx: HarnessUninstallContext,
	): Promise<HarnessUninstallResult> {
		const locations = universalLocationResolver.resolve(
			ctx.scope,
			ctx.projectRoot,
			ctx.homeDir,
		);
		return {
			skills: uninstallSkillFiles(locations.skillsDir, listBaseSkillNames()),
			agents: { removed: [], notFound: [] },
		};
	},
};

export default universalPlugin;
