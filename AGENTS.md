# AGENTS.md

Development of this project is done with the help of Claude Code (Anthropic).

- Client-only static app (Vite + TypeScript). No backend; user files must never be uploaded anywhere.
- Heavy geometry (Clipper2, manifold-3d) runs in `src/worker.ts`, not on the UI thread.
- Units are millimetres throughout. Defaults live in `src/settings.ts`.
- Must stay CAD-agnostic: never assume a single CAD's Gerber file naming.
- Everything in the repo is in English.
- Dev check without a browser: `npx tsx scripts/silk-pdf.mts <board.zip|dir> <out.pdf>` runs the real pipeline in Node.
