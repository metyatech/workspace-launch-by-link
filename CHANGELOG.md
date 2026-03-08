# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- ESLint and Prettier for code quality and consistency.
- Vitest for automated testing.
- `verify` script to run all checks in one command.
- `AGENTS.md` and `agent-ruleset.json` for autonomous agent compliance.
- `CHANGELOG.md`, `CONTRIBUTING.md`, and `SECURITY.md`.

### Changed
- Migrated to ESM (`type: module` in `package.json`).
- Updated `tsconfig.json` for ESM support.
- Improved code quality in `src/extension.ts` (removed unused variables, fixed types).
