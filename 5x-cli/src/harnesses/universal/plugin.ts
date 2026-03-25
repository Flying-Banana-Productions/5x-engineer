import {
	listBaseSkillNames,
	renderAllSkillTemplates,
} from "../../skills/loader.js";
import { installSkillFiles, uninstallSkillFiles } from "../installer.js";
import { universalLocationResolver } from "../locations.js";
import type {
	HarnessDescription,
	HarnessInstallContext,
	HarnessInstallResult,
	HarnessPlugin,
	HarnessScope,
	HarnessUninstallContext,
	HarnessUninstallResult,
} from "../types.js";

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

	async install(ctx: HarnessInstallContext): Promise<HarnessInstallResult> {
		const locations = universalLocationResolver.resolve(
			ctx.scope,
			ctx.projectRoot,
			ctx.homeDir,
		);
		const skills = renderAllSkillTemplates({ native: false });
		return {
			skills: installSkillFiles(locations.skillsDir, skills, ctx.force),
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
