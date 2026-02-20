/**
 * Tests for permission policy handling.
 *
 * Phase 3 of 004-impl-5x-cli-tui.
 */

import { describe, expect, it, jest } from "bun:test";
import {
	createPermissionHandler,
	NON_INTERACTIVE_NO_FLAG_ERROR,
	type PermissionPolicy,
} from "../../src/tui/permissions.js";

// Mock OpencodeClient for testing
type MockOpencodeClient = {
	event: {
		subscribe: ReturnType<typeof jest.fn>;
	};
	permission: {
		reply: ReturnType<typeof jest.fn>;
	};
};

function createMockClient(): MockOpencodeClient {
	return {
		event: {
			subscribe: jest.fn(),
		},
		permission: {
			reply: jest.fn().mockResolvedValue(true),
		},
	};
}

/**
 * Create a mock SSE stream that yields events.
 */
async function* createMockStream(
	events: Array<{ type: string; properties?: Record<string, unknown> }>,
) {
	for (const event of events) {
		yield event;
	}
}

describe("createPermissionHandler", () => {
	describe("auto-approve-all mode", () => {
		it("should approve permission requests immediately", async () => {
			const client = createMockClient();
			const policy: PermissionPolicy = { mode: "auto-approve-all" };

			// Mock the event stream with a permission request
			const mockStream = createMockStream([
				{
					type: "permission.asked",
					properties: {
						id: "req-123",
						tool: "fs_read",
						arguments: { path: "/some/path" },
					},
				},
			]);

			client.event.subscribe.mockResolvedValue({
				stream: mockStream,
			});

			const handler = createPermissionHandler(
				client as unknown as import("@opencode-ai/sdk/v2").OpencodeClient,
				policy,
			);

			handler.start();

			// Wait for async processing
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Should have called permission.reply
			expect(client.permission.reply).toHaveBeenCalledWith({
				requestID: "req-123",
				reply: "once",
			});

			handler.stop();
		});

		it("should handle multiple permission requests", async () => {
			const client = createMockClient();
			const policy: PermissionPolicy = { mode: "auto-approve-all" };

			const mockStream = createMockStream([
				{
					type: "permission.asked",
					properties: { id: "req-1", tool: "fs_read", arguments: {} },
				},
				{
					type: "permission.asked",
					properties: { id: "req-2", tool: "fs_write", arguments: {} },
				},
				{
					type: "permission.asked",
					properties: { id: "req-3", tool: "bash", arguments: {} },
				},
			]);

			client.event.subscribe.mockResolvedValue({
				stream: mockStream,
			});

			const handler = createPermissionHandler(
				client as unknown as import("@opencode-ai/sdk/v2").OpencodeClient,
				policy,
			);

			handler.start();
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(client.permission.reply).toHaveBeenCalledTimes(3);
			expect(client.permission.reply).toHaveBeenNthCalledWith(1, {
				requestID: "req-1",
				reply: "once",
			});
			expect(client.permission.reply).toHaveBeenNthCalledWith(2, {
				requestID: "req-2",
				reply: "once",
			});
			expect(client.permission.reply).toHaveBeenNthCalledWith(3, {
				requestID: "req-3",
				reply: "once",
			});

			handler.stop();
		});

		it("should ignore errors from permission.reply (e.g., timeout)", async () => {
			const client = createMockClient();
			client.permission.reply.mockRejectedValue(new Error("Timeout"));

			const policy: PermissionPolicy = { mode: "auto-approve-all" };

			const mockStream = createMockStream([
				{
					type: "permission.asked",
					properties: { id: "req-123", tool: "fs_read", arguments: {} },
				},
			]);

			client.event.subscribe.mockResolvedValue({
				stream: mockStream,
			});

			const handler = createPermissionHandler(
				client as unknown as import("@opencode-ai/sdk/v2").OpencodeClient,
				policy,
			);

			// Should not throw
			expect(() => handler.start()).not.toThrow();
			await new Promise((resolve) => setTimeout(resolve, 50));

			handler.stop();
		});

		it("should stop listening when stop() is called", async () => {
			const client = createMockClient();
			const policy: PermissionPolicy = { mode: "auto-approve-all" };

			const mockStream = createMockStream([
				{
					type: "permission.asked",
					properties: { id: "req-1", tool: "fs_read", arguments: {} },
				},
			]);

			client.event.subscribe.mockResolvedValue({
				stream: mockStream,
			});

			const handler = createPermissionHandler(
				client as unknown as import("@opencode-ai/sdk/v2").OpencodeClient,
				policy,
			);

			handler.start();
			handler.stop();

			// Wait a bit
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Should not have processed any events after stop
			expect(client.permission.reply).not.toHaveBeenCalled();
		});
	});

	describe("tui-native mode", () => {
		it("should be a no-op (does not subscribe to events)", () => {
			const client = createMockClient();
			const policy: PermissionPolicy = { mode: "tui-native" };

			const handler = createPermissionHandler(
				client as unknown as import("@opencode-ai/sdk/v2").OpencodeClient,
				policy,
			);

			handler.start();

			// Should not subscribe to events
			expect(client.event.subscribe).not.toHaveBeenCalled();

			handler.stop();
		});
	});

	describe("workdir-scoped mode", () => {
		it("should auto-approve file operations within workdir", async () => {
			const client = createMockClient();
			const workdir = "/project";
			const policy: PermissionPolicy = { mode: "workdir-scoped", workdir };

			const mockStream = createMockStream([
				{
					type: "permission.asked",
					properties: {
						id: "req-1",
						tool: "fs_read",
						arguments: { path: "/project/src/file.ts" },
					},
				},
			]);

			client.event.subscribe.mockResolvedValue({
				stream: mockStream,
			});

			const handler = createPermissionHandler(
				client as unknown as import("@opencode-ai/sdk/v2").OpencodeClient,
				policy,
			);

			handler.start();
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(client.permission.reply).toHaveBeenCalledWith({
				requestID: "req-1",
				reply: "once",
			});

			handler.stop();
		});

		it("should NOT auto-approve file operations outside workdir", async () => {
			const client = createMockClient();
			const workdir = "/project";
			const policy: PermissionPolicy = { mode: "workdir-scoped", workdir };

			const mockStream = createMockStream([
				{
					type: "permission.asked",
					properties: {
						id: "req-1",
						tool: "fs_read",
						arguments: { path: "/etc/passwd" },
					},
				},
			]);

			client.event.subscribe.mockResolvedValue({
				stream: mockStream,
			});

			const handler = createPermissionHandler(
				client as unknown as import("@opencode-ai/sdk/v2").OpencodeClient,
				policy,
			);

			handler.start();
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Should NOT have called permission.reply
			expect(client.permission.reply).not.toHaveBeenCalled();

			handler.stop();
		});

		it("should auto-approve relative paths (assumed relative to workdir)", async () => {
			const client = createMockClient();
			const workdir = "/project";
			const policy: PermissionPolicy = { mode: "workdir-scoped", workdir };

			const mockStream = createMockStream([
				{
					type: "permission.asked",
					properties: {
						id: "req-1",
						tool: "fs_write",
						arguments: { path: "src/file.ts" },
					},
				},
			]);

			client.event.subscribe.mockResolvedValue({
				stream: mockStream,
			});

			const handler = createPermissionHandler(
				client as unknown as import("@opencode-ai/sdk/v2").OpencodeClient,
				policy,
			);

			handler.start();
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(client.permission.reply).toHaveBeenCalledWith({
				requestID: "req-1",
				reply: "once",
			});

			handler.stop();
		});

		it("should handle fs_edit tool", async () => {
			const client = createMockClient();
			const workdir = "/project";
			const policy: PermissionPolicy = { mode: "workdir-scoped", workdir };

			const mockStream = createMockStream([
				{
					type: "permission.asked",
					properties: {
						id: "req-1",
						tool: "fs_edit",
						arguments: { path: "/project/README.md" },
					},
				},
			]);

			client.event.subscribe.mockResolvedValue({
				stream: mockStream,
			});

			const handler = createPermissionHandler(
				client as unknown as import("@opencode-ai/sdk/v2").OpencodeClient,
				policy,
			);

			handler.start();
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(client.permission.reply).toHaveBeenCalled();

			handler.stop();
		});

		it("should not auto-approve bash commands (cannot extract path)", async () => {
			const client = createMockClient();
			const workdir = "/project";
			const policy: PermissionPolicy = { mode: "workdir-scoped", workdir };

			const mockStream = createMockStream([
				{
					type: "permission.asked",
					properties: {
						id: "req-1",
						tool: "bash",
						arguments: { command: "rm -rf /" },
					},
				},
			]);

			client.event.subscribe.mockResolvedValue({
				stream: mockStream,
			});

			const handler = createPermissionHandler(
				client as unknown as import("@opencode-ai/sdk/v2").OpencodeClient,
				policy,
			);

			handler.start();
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Should NOT have called permission.reply for bash
			expect(client.permission.reply).not.toHaveBeenCalled();

			handler.stop();
		});
	});

	describe("NON_INTERACTIVE_NO_FLAG_ERROR", () => {
		it("should contain actionable error message", () => {
			expect(NON_INTERACTIVE_NO_FLAG_ERROR).toContain("--auto");
			expect(NON_INTERACTIVE_NO_FLAG_ERROR).toContain("--ci");
			expect(NON_INTERACTIVE_NO_FLAG_ERROR).toContain("non-interactively");
		});
	});
});
