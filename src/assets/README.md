# Rill artwork

The cat and handwritten wordmark use SVG paths with transparent backgrounds.
They contain no embedded bitmaps or image filters.

The `.svg.bin` suffix uses Wrangler's built-in binary module support so existing
installations need no changes to their saved configuration. `src/brand.ts` decodes
the SVGs and frames the cat's face for the favicon.

After editing the vector assets, run `node scripts/generate-brand.mjs` to regenerate
both GitHub README themes from the same paths. Bump `BRAND_VERSION` in `src/brand.ts`
when changing the artwork so existing clients fetch it again.
