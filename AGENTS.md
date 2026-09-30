# Development rules

This repository contains the Okazaki WebXR app only. Preserve the original PLATEAU models and the separate Unity project. Do not include credentials, source-data caches, node_modules, dist, or local test reports in commits.

## Workflow

1. Create or use an Issue with purpose, scope, acceptance criteria and verification.
2. Work on an Issue-numbered branch such as `codex/1-cloudflare-cicd`; do not push changes directly to main.
3. Open a PR that links the Issue and identifies the exact head SHA and completed checks.
4. Request `@codex review`. If unavailable, perform an independent local review of the final diff and record reviewer, SHA, findings, fixes and remaining limitations in the PR. A request with no response is not a completed review.
5. Fix actionable findings and verify the final head. CI must pass before squash merge.
6. GitHub Actions performs CI only: never deploy from a push, workflow dispatch or PR. When publication is included in the user's request, Codex checks the merged main SHA, origin/main parity, clean worktree and successful final-main CI; builds/checks that exact source locally or uses its verified CI artifact; then runs `npm run deploy` and `node scripts/verify-deployed.mjs` locally. Record the commit, PR, CI run, Cloudflare version and published-file checks. Do not call a pending/failed deployment complete.

## Checks

Use Node.js 22 and `npm ci`, `npm test`, `npm run check:assets`, `npm run build`, and `npm run check:production`. For UI/XR changes also run relevant browser and XR-emulator tests, and explicitly distinguish emulator evidence from physical Quest acceptance.

## Code Review Rules

- Keep deployment credentials out of code, PRs, logs and all GitHub Actions jobs. CI never publishes. Codex publishes only verified merged main using the local Wrangler authentication; never copy OAuth/refresh tokens into GitHub Secrets or source.
- Preserve model/image bytes and their declared hashes. Generated caches are not distribution assets. Do not silently substitute fake terrain when source data fails.
- XR transitions and input loss must stop movement safely, preserve the intended view, and not unexpectedly reset or reload the page. Physical Quest comfort and readability require real-device evidence.
