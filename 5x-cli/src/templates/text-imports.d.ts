// Type declarations for Bun text imports of .md files
declare module "*.md" {
	const content: string;
	export default content;
}
