---
name: repo-manifest
description: Manages external dependency repos via repos.yaml manifest. Clone, sync, fork, and explore upstream source code. Use when exploring dependency source, contributing to upstream forks, cloning external repos, or when the user mentions repos.yaml, repo manifest, or upstream repos.
---

# Repo Manifest

Tau tracks ~47 external dependency repos via `repos.yaml` at the workspace root. Repos are cloned into `repos/` (gitignored). The manifest defines upstream URLs, taucad forks, branches, groups, and descriptions.

## Quick Reference

```bash
# Interactive TUI (humans)
pnpm repos

# Headless commands (agents/scripts)
pnpm repos list --json                    # All repos from manifest
pnpm repos list --cloned --json           # Only cloned repos
pnpm repos list --groups                  # Show groups
pnpm repos clone langchainjs              # Clone specific repo
pnpm repos clone --group cad              # Clone a group
pnpm repos clone --all                    # Clone everything
pnpm repos sync --all                     # Pull latest (ff-only)
pnpm repos status --all --json            # Branch, dirty, ahead/behind
pnpm repos fork three.js                  # Fork upstream to taucad org
pnpm repos unfork three.js               # Revert to upstream-only
pnpm repos exec --group cad -- git status # Run command across repos
```

## Reading the Manifest

Read `repos.yaml` directly for project landscape context without cloning:

```yaml
owner: taucad          # Org used for automated forking
repos:
  langchainjs:
    upstream: langchain-ai/langchainjs
    fork: taucad/langchainjs       # fork field = writable
    branch: feat/...
    description: LangChain.js - LLM framework
  three.js:
    upstream: mrdoob/three.js      # no fork = read-only
    branch: dev
```

- Repos with `fork` field: you can push to origin (the fork). Upstream is read-only.
- Repos without `fork`: origin points to upstream. Read-only exploration.

## Fork Workflow

To contribute changes upstream through a taucad fork:

1. `pnpm repos fork <name>` -- forks to taucad org, updates YAML and git remotes
2. Work in `repos/<name>/`, commit changes
3. `git push origin <branch>` -- pushes to taucad fork
4. Create PR from taucad fork to upstream via `gh pr create`

## Groups

| Group | Purpose |
|---|---|
| `cad` | Core CAD/geometry: replicad, opencascade.js, manifold, OCCT, lib3mf |
| `slicers` | 3D printer slicers: BambuStudio, OrcaSlicer, PrusaSlicer |
| `ai` | AI/LLM frameworks: langchainjs, langgraphjs, ai |
| `3d` | 3D rendering: three.js, react-three-fiber, model-viewer, glTF-Transform |
| `dev-tools` | Dev tools: nx, pnpm, vscode, typescript-go, xstate |
| `tscircuit` | tscircuit EDA ecosystem |
| `zenfs` | ZenFS filesystem abstractions |

## For Agents

- Read `repos.yaml` first to understand what repos exist and their relationships
- Use `pnpm repos list --json` for structured output
- Use `pnpm repos clone --group <name>` to selectively clone only what you need
- All commands support `--json` for machine-readable output
- Clone is idempotent -- safe to re-run without checking state
