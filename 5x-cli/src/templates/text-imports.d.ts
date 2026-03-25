// Type declarations for Bun text imports of .md and .toml files
declare module "*.md" {
	const content: string;
	export default content;
}

declare module "*.mdc" {
	const content: string;
	export default content;
}

declare module "*.toml" {
	const content: string;
	export default content;
}
