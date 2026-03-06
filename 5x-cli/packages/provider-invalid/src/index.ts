/**
 * Invalid provider plugin fixture — intentionally exports an invalid ProviderPlugin.
 *
 * This fixture is used to test INVALID_PROVIDER error handling.
 * The module exports a default that is missing the required `create` function.
 */

// Invalid export: missing `create` function
const invalidPlugin = {
	name: "invalid",
	// create is missing — this violates the ProviderPlugin contract
};

export default invalidPlugin;
