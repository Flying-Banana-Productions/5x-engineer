#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { version } from "./version.js";

const main = defineCommand({
	meta: {
		name: "5x",
		version,
		description: "Automated author-review loop runner for the 5x workflow",
	},
	subCommands: {
		status: () => import("./commands/status.js").then((m) => m.default),
		init: () => import("./commands/init.js").then((m) => m.default),
	},
});

runMain(main);
