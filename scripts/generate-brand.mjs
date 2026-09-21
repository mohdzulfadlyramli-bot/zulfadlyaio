import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const cat = readFileSync(new URL('src/assets/rill-cat.svg.bin', root), 'utf8').trim();
const wordmark = readFileSync(new URL('src/assets/rill-wordmark.svg.bin', root), 'utf8').trim();

function place(svg, x, y, width, height) {
  return svg.replace(/width="\d+" height="\d+"/, `x="${x}" y="${y}" width="${width}" height="${height}"`);
}

// GitHub and the app share exactly the same paths; only the lettering color changes.
for (const [name, ink] of [['rill', '#171717'], ['rill-dark', '#ffffff']]) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="226" viewBox="0 0 520 226" role="img" aria-label="Rill"><title>Rill</title>\n${place(cat, 0, 0, 196, 226)}\n${place(wordmark.replaceAll('#f3f3f3', ink), 228, 94, 292, 120)}\n</svg>\n`;
  writeFileSync(new URL(`docs/brand/${name}.svg`, root), svg);
}
