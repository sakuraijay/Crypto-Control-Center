---
name: Template literal escaping bug
description: A prior subagent wrote escaped template literals throughout the codebase — never repeat this pattern
---

A previous subagent wrote `\${variable}` (backslash-escaped) instead of `${variable}` inside JSX and TypeScript template literals. This caused literal backslash-dollar signs to appear in the rendered UI instead of interpolated values.

**Why:** The subagent's code generator was incorrectly escaping template literal expressions, treating them as regex or shell escapes.

**How to apply:** Always write `${expression}` inside backtick template literals. Never write `\${...}`. In TSX files, string interpolation inside style props uses the standard JS template literal syntax.
