import { createRenderContext } from "../../skills/renderer.js";
import {
	assetsOfKind,
	installAgentFiles,
	installRuleFiles,
	installSkillFiles,
	removeStaleAgentFiles,
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
	RenderedAsset,
} from "../types.js";
import ruleTemplate from "./5x-orchestrator.mdc" with { type: "text" };
import permissionsTemplate from "./5x-permissions.mdc" with { type: "text" };
import { listAgentTemplates, renderAgentTemplates } from "./loader.js";
import { listSkillNames, listSkills } from "./skills/loader.js";

/**
 * Render every managed Cursor asset for this context without writing.
 *
 * Module-level so `install()` can dispatch over the exact same call the Tier 2
 * freshness check makes — one render path, not two (201 §2.5).
 *
 * Rules render from static templates with no config inputs and exist only at
 * project scope: Cursor user rules are settings-managed, not file-backed.
 */
async function renderCursorAssets(
	ctx: HarnessInstallContext,
): Promise<RenderedAsset[]> {
	// Resolve skill render context from delegation config
	// authorNative = true when delegationMode is NOT "invoke"
	const authorNative = ctx.config.authorDelegationMode !== "invoke";
	const reviewerNative = ctx.config.reviewerDelegationMode !== "invoke";
	const skillRenderContext = createRenderContext(
		authorNative && reviewerNative, // legacy native flag (both native)
		authorNative,
		reviewerNative,
	);

	const assets: RenderedAsset[] = [];

	for (const skill of listSkills(skillRenderContext)) {
		assets.push({
			kind: "skill",
			name: skill.name,
			path: `skills/${skill.name}/SKILL.md`,
			content: skill.content,
		});
	}

	// Skip agent templates for roles that use invoke delegation
	for (const agent of renderAgentTemplates({
		authorModel: ctx.config.authorModel,
		reviewerModel: ctx.config.reviewerModel,
		authorInvoke: !authorNative,
		reviewerInvoke: !reviewerNative,
	})) {
		assets.push({
			kind: "agent",
			name: agent.name,
			path: `agents/${agent.name}.md`,
			content: agent.content,
		});
	}

	const locations = cursorLocationResolver.resolve(
		ctx.scope,
		ctx.projectRoot,
		ctx.homeDir,
	);
	if (ctx.scope === "project" && locations.rulesDir) {
		assets.push({
			kind: "rule",
			name: "5x-orchestrator",
			path: "rules/5x-orchestrator.mdc",
			content: ruleTemplate,
		});
		assets.push({
			kind: "rule",
			name: "5x-permissions",
			path: "rules/5x-permissions.mdc",
			content: permissionsTemplate,
		});
	}

	return assets;
}

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
			ruleNames: ["5x-orchestrator", "5x-permissions"],
			capabilities: { rules: true },
		};
	},

	renderAssets: renderCursorAssets,

	async install(ctx: HarnessInstallContext): Promise<HarnessInstallResult> {
		const locations = cursorLocationResolver.resolve(
			ctx.scope,
			ctx.projectRoot,
			ctx.homeDir,
		);

		// Install is a thin writer over the one render path.
		const rendered = await renderCursorAssets(ctx);
		const agentTemplates = assetsOfKind(rendered, "agent");

		const skills = installSkillFiles(
			locations.skillsDir,
			assetsOfKind(rendered, "skill"),
			ctx.force,
		);
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

		if (ctx.scope === "project" && locations.rulesDir) {
			const rules = installRuleFiles(
				locations.rulesDir,
				assetsOfKind(rendered, "rule"),
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
