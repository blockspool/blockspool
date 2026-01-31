# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2025-01-26

### Added
- Initial open source release
- `@blockspool/core` - Core business logic and database adapter interface
- `@blockspool/cli` - Command-line interface with solo mode
- `@blockspool/sqlite` - Zero-config SQLite adapter for local development
- Solo mode commands: `init`, `scout`, `run`, `pr`, `auto`, `status`, `doctor`
- TUI dashboard for monitoring long-running sessions
- Built-in starter pack with CI fix automation

### Security
- All packages published with npm provenance

[Unreleased]: https://github.com/blockspool/blockspool/compare/v0.2.0...HEAD
[0.1.0]: https://github.com/blockspool/blockspool/releases/tag/v0.2.0
