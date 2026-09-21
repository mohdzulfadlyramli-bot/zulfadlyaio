import cat from './assets/rill-cat.svg.bin';
import wordmark from './assets/rill-wordmark.svg.bin';

export const BRAND_NAME = 'Rill';
export const BRAND_VERSION = 'vector-cat-9';

// True vector paths stay sharp at every display size without raster filters.
// Binary imports preserve compatibility with installations' saved Wrangler rules.
export const BRAND_LOGO = new TextDecoder().decode(cat);
export const BRAND_WORDMARK = new TextDecoder().decode(wordmark);
export const BRAND_ICON = BRAND_LOGO
  .replace('width="1050" height="1200"', 'width="875" height="875"')
  .replace('viewBox="110 30 1050 1200"', 'viewBox="125 20 875 875"');
