# Specification: Interactive Config TUI & Configurable Size Gate

## Overview

This specification consolidates requirements for:
1. Adding `max_changed_lines` and `max_changed_files` into the configuration schema with `capped` fold direction.
2. Building an interactive, keyboard-driven configuration editor in the pr-hero TUI that focuses on actionable scalar options with in-place controls (boolean toggle, numeric steppers, presets/text, and unset).

## Sub-Specifications

- [Configurable Size Gate in Configuration Schema](specs/config-schema-size-gate.md)
- [Interactive Configuration TUI](specs/interactive-config-tui.md)
