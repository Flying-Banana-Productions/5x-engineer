import {
	installAgentFiles,
	installRuleFiles,
	installSkillFiles,
	uninstallAgentFiles,
	uninstallRuleFiles,
	uninstallSkillFiles,
} from "../installer.js";
import { cursorLocationResolver } from "../locations.js";
import type {
	HarnessDescription,
	HarnessInstallContext,
	HarnessInstallResult,
	HarnessPlugin,
	HarnessScope,
	HarnessUninstallContext,
	HarnessUninstallResult,
} from "../types.js";
import ruleTemplate from "./5x-orchestrator.mdc" with { type: "text" };
import { listAgentTemplates, renderAgentTemplates } from "./loader.js";
import { listSkillNames, listSkills } from "./skills/loader.js";

const cursorPlugin: HarnessPlugin = {
	name: "cursor",
	description: "Install 5x skills, subagents, and orchestrator rule for Cursor",
	supportedScopes: ["project", "user"],

	locations: cursorLocationResolver,

	describe(scope?: HarnessScope): HarnessDescription {
		const skillNames = listSkillNames();
		const agentNames = listAgentTemplates().map((t) => t.name);

		if (scope === "user") {
			return {
				skillNames,
				agentNames,
				ruleNames: [],
				capabilities: { rules: false },
			};
		}

		return {
			skillNames,
			agentNames,
			ruleNames: ["5x-orchestrator"],
			capabilities: { rules: true },
		};
	},

	async install(ctx: HarnessInstallContext): Promise<HarnessInstallResult> {
		const locations = cursorLocationResolver.resolve(
			ctx.scope,
			ctx.projectRoot,
			ctx.homeDir,
		);

		const skills = installSkillFiles(
			locations.skillsDir,
			listSkills(),
			ctx.force,
		);

		const agentTemplates = renderAgentTemplates({
			authorModel: ctx.config.authorModel,
			reviewerModel: ctx.config.reviewerModel,
		});
		const agents = installAgentFiles(
			locations.agentsDir,
			agentTemplates,
			ctx.force,
		);

		if (ctx.scope === "project" && locations.rulesDir) {
			const rules = installRuleFiles(
				locations.rulesDir,
				[{ name: "5x-orchestrator", content: ruleTemplate }],
				ctx.force,
			);
			return { skills, agents, rules };
		}

		return {
			skills,
			agents,
			unsupported: { rules: true },
			warnings: [
				"Cursor user rules are settings-managed and not file-backed. Install with --scope project to add the orchestrator rule to your project.",
			],
		};
	},

	async uninstall(
		ctx: HarnessUninstallContext,
	): Promise<HarnessUninstallResult> {
		const locations = this.locations.resolve(
			ctx.scope,
			ctx.projectRoot,
			ctx.homeDir,
		);
		const { skillNames, agentNames, ruleNames } = this.describe(ctx.scope);

		const skills = uninstallSkillFiles(locations.skillsDir, skillNames);
		const agents = uninstallAgentFiles(locations.agentsDir, agentNames);

		if (ctx.scope === "project" && locations.rulesDir && ruleNames?.length) {
			const rules = uninstallRuleFiles(locations.rulesDir, ruleNames);
			return { skills, agents, rules };
		}

		return {
			skills,
			agents,
			unsupported: { rules: true },
		};
	},
};

export default cursorPlugin;
