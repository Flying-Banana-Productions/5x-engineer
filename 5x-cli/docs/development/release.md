# Releasing `@5x-ai/5x-cli`

Releases use GitHub Actions OIDC trusted publishing and npm staged publishing.
No npm write token is stored in this repository or supplied to the workflow.

## One-Time Setup

On the npm package settings page, configure a GitHub Actions trusted publisher:

- Organization: `Flying-Banana-Productions`
- Repository: `5x-engineer`
- Workflow filename: `5x-cli-publish.yml`
- Allowed action: `npm stage publish` only

After a successful staged publish, set Publishing access to **Require two-factor
authentication and disallow tokens**, then revoke obsolete npm write tokens.

## Release Procedure

1. Update `5x-cli/package.json` and `5x-cli/CHANGELOG.md`, then commit and push
   the release commit to `main`.
2. Create and push an annotated `5x-cli-v<version>` tag pointing to that commit.
   The `Stage 5x-cli Release` workflow validates that the tag version matches
   `5x-cli/package.json`, runs lint, typecheck, tests, and package validation,
   then runs `npm stage publish` using OIDC.
3. Review the staged package and approve it with npm 2FA. The package becomes
   public only after that approval.
4. Confirm the published version, then create the GitHub Release from the
   corresponding `CHANGELOG.md` entry.

To stage an existing release tag after this workflow is added, run `Stage 5x-cli
Release` manually and provide the tag as `release_tag`.
