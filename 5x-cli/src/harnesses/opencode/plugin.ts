/**
 * Bundled OpenCode harness plugin.
 *
 * Implements the HarnessPlugin contract by wrapping the existing
 * location resolver, agent template renderer, and file installer.
 *
 * This is the default harness — third-party packages can override it
 * by publishing @5x-ai/harness-opencode (or any scoped package) and
 * having it installed in the project.
 */

import { listSkillNames } from "../../skills/loader.js";
import {
	installAgentFiles,
	installSkillFiles,
	uninstallAgentFiles,
	uninstallSkillFiles,
} from "../installer.js";
import { opencodeLocationResolver } from "../locations.js";
import type {
	HarnessDescription,
	HarnessInstallContext,
	HarnessInstallResult,
	HarnessPlugin,
	HarnessUninstallContext,
	HarnessUninstallResult,
} from "../types.js";
import { listAgentTemplates, renderAgentTemplates } from "./loader.js";

const opencodePlugin: HarnessPlugin = {
	name: "opencode",
	description: "Install 5x skills and native subagent profiles for OpenCode",
	supportedScopes: ["project", "user"],

	locations: opencodeLocationResolver,

	describe(): HarnessDescription {
		const skillNames = listSkillNames();
		const agentNames = listAgentTemplates().map((t) => t.name);
		return { skillNames, agentNames };
	},

	async install(ctx: HarnessInstallContext): Promise<HarnessInstallResult> {
		const locations = opencodeLocationResolver.resolve(
			ctx.scope,
			ctx.projectRoot,
		);

		// Install skills
		const skills = installSkillFiles(
			locations.skillsDir,
			ctx.skills,
			ctx.force,
		);

		// Render and install agent profiles
		const agentTemplates = renderAgentTemplates({
			authorModel: ctx.config.authorModel,
			reviewerModel: ctx.config.reviewerModel,
		});
		const agents = installAgentFiles(
			locations.agentsDir,
			agentTemplates,
			ctx.force,
		);

		return { skills, agents };
	},

	async uninstall(
		ctx: HarnessUninstallContext,
	): Promise<HarnessUninstallResult> {
		const locations = this.locations.resolve(ctx.scope, ctx.projectRoot);
		const { skillNames, agentNames } = this.describe();

		const skills = uninstallSkillFiles(locations.skillsDir, skillNames);
		const agents = uninstallAgentFiles(locations.agentsDir, agentNames);

		return { skills, agents };
	},
};

export default opencodePlugin;
