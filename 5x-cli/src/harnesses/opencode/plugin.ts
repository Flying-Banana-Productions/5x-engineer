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

import { installAgentFiles, installSkillFiles } from "../installer.js";
import { opencodeLocationResolver } from "../locations.js";
import type {
	HarnessInstallContext,
	HarnessInstallResult,
	HarnessPlugin,
} from "../types.js";
import { renderAgentTemplates } from "./loader.js";

const opencodePlugin: HarnessPlugin = {
	name: "opencode",
	description: "Install 5x skills and native subagent profiles for OpenCode",
	supportedScopes: ["project", "user"],

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
};

export default opencodePlugin;
