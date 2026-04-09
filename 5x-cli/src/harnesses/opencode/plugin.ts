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

import {
	installAgentFiles,
	installSkillFiles,
	removeStaleAgentFiles,
	uninstallAgentFiles,
	uninstallSkillFiles,
} from "../installer.js";
import { opencodeLocationResolver } from "../locations.js";
import type {
	HarnessDescription,
	HarnessInstallContext,
	HarnessInstallResult,
	HarnessPlugin,
	HarnessScope,
	HarnessUninstallContext,
	HarnessUninstallResult,
} from "../types.js";
import { listAgentTemplates, renderAgentTemplates } from "./loader.js";
import { listSkillNames, listSkills } from "./skills/loader.js";

const opencodePlugin: HarnessPlugin = {
	name: "opencode",
	description: "Install 5x skills and native subagent profiles for OpenCode",
	supportedScopes: ["project", "user"],

	locations: opencodeLocationResolver,

	describe(scope?: HarnessScope): HarnessDescription {
		const skillNames = listSkillNames();
		const agentNames = listAgentTemplates().map((t) => t.name);

		if (scope) {
			return {
				skillNames,
				agentNames,
				ruleNames: [],
				capabilities: { rules: false },
			};
		}

		return { skillNames, agentNames };
	},

	async install(ctx: HarnessInstallContext): Promise<HarnessInstallResult> {
		const locations = opencodeLocationResolver.resolve(
			ctx.scope,
			ctx.projectRoot,
			ctx.homeDir,
		);

		// Install skills
		const skills = installSkillFiles(
			locations.skillsDir,
			listSkills(),
			ctx.force,
		);

		// Render and install agent profiles
		// Skip agent templates for roles that use invoke delegation
		const agentTemplates = renderAgentTemplates({
			authorModel: ctx.config.authorModel,
			reviewerModel: ctx.config.reviewerModel,
			authorInvoke: ctx.config.authorDelegationMode === "invoke",
			reviewerInvoke: ctx.config.reviewerDelegationMode === "invoke",
		});
		const agents = installAgentFiles(
			locations.agentsDir,
			agentTemplates,
			ctx.force,
		);

		// Remove stale agent files (e.g., when switching from native to invoke mode)
		// Only delete 5x-managed files, preserving user-authored or third-party agents
		const allManagedAgents = listAgentTemplates().map((t) => t.name);
		const staleRemoved = removeStaleAgentFiles(
			locations.agentsDir,
			agentTemplates.map((t) => t.name),
			allManagedAgents,
		);
		// Include stale removals in the result for reporting
		if (staleRemoved.length > 0) {
			agents.removed = staleRemoved;
		}

		return { skills, agents };
	},

	async uninstall(
		ctx: HarnessUninstallContext,
	): Promise<HarnessUninstallResult> {
		const locations = this.locations.resolve(
			ctx.scope,
			ctx.projectRoot,
			ctx.homeDir,
		);
		const { skillNames, agentNames } = this.describe();

		const skills = uninstallSkillFiles(locations.skillsDir, skillNames);
		const agents = uninstallAgentFiles(locations.agentsDir, agentNames);

		return { skills, agents };
	},
};

export default opencodePlugin;
