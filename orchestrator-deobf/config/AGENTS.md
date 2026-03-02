# AGENTS.md

## Purpose
Keep generator output structurally aligned with CodexMonitor-style project layout through one strict contract.

## Source of Truth
- `codexmonitor-structure-contract.json`

## Rules
- Quality gate must fail-fast if the contract file is missing or invalid.
- Structural decisions (domain roots, forbidden prefixes, path regex rules) must be updated only in contract, not hardcoded in stage logic.
- Hot-file limits (`maxLines`, `maxNamespaceImports`, `minLiftedCoverage`) are contract-driven and enforced for hot-focus modules every run.

## Intent
Reduce architectural drift and make output deterministic, readable, and manual-ready.
