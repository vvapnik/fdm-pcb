# FDM-PCB

**Live:** https://vvapnik.github.io/fdm-pcb/

Browser-only tool for [open-garden](https://github.com/vvapnik/open-garden-rack): converts Gerber/Excellon
files from any CAD (Fusion, KiCad, EasyEDA…) into a 3D-printable **relief PCB** and a printable silkscreen PDF.

- **Single-sided:** one STL — substrate (default 1.6 mm) with copper areas raised (default 0.8 mm) so copper foil can be glued on top.
- **Double-sided:** two STL halves split through the middle of the substrate (default 0.6 mm each + 0.8 mm relief), aligned by drill holes.
- **STEP:** each part can also be exported as a STEP B-rep (substrate + copper bodies, drill holes as true cylinders) for editing in CAD.
- **Silkscreen:** vector PDF at exact 1:1 scale for a normal printer.

All thicknesses and clearance settings are adjustable in the UI. No backend: files never leave the browser.

Stack: Vite + TypeScript, tracespace (Gerber parsing), manifold-3d (Clipper2-based 2D booleans/offsets and 3D), three.js (preview), jsPDF + svg2pdf.js (PDF).

```bash
npm install
npm run dev
```

Pushing to `main` deploys to GitHub Pages (`.github/workflows/pages.yml`).

Plans and tasks live on the Lab board: `backlog task list --project fdm-pcb` · plan diagram: `fdm-pcb-plan.html` next to this repo in the Lab workspace

Developed with the help of Claude Code (Anthropic).
