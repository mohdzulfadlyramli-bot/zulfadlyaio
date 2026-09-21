
export interface LangParts {
  lang: string;
  region?: string;
}

export function splitLanguageTag(tag: string | undefined | null): LangParts {
  const raw = String(tag || '').trim().replace(/_/g, '-');
  if (!raw) return { lang: 'en' };
  const [l, r] = raw.split('-');
  const lang = (l || 'en').toLowerCase();
  const region = r && /^[a-z]{2}$/i.test(r) ? r.toUpperCase() : undefined;
  return { lang, region };
}

export function tmdbLanguage(tag: string | undefined): string {
  const { lang, region } = splitLanguageTag(tag);
  return region ? `${lang}-${region}` : lang;
}

export function regionOf(tag: string | undefined, fallback = 'US'): string {
  return splitLanguageTag(tag).region || fallback;
}

export function fanartLanguage(tag: string | undefined): string {
  return splitLanguageTag(tag).lang;
}

const ISO2_TO_3: Record<string, string> = {
  aa: 'aar', ab: 'abk', af: 'afr', am: 'amh', ar: 'ara', as: 'asm', ay: 'aym', az: 'aze',
  ba: 'bak', be: 'bel', bg: 'bul', bn: 'ben', bo: 'bod', br: 'bre', bs: 'bos',
  ca: 'cat', cs: 'ces', cy: 'cym', da: 'dan', de: 'deu', el: 'ell', en: 'eng', eo: 'epo',
  es: 'spa', et: 'est', eu: 'eus', fa: 'fas', fi: 'fin', fo: 'fao', fr: 'fra', fy: 'fry',
  ga: 'gle', gd: 'gla', gl: 'glg', gu: 'guj', he: 'heb', hi: 'hin', hr: 'hrv', hu: 'hun',
  hy: 'hye', id: 'ind', is: 'isl', it: 'ita', ja: 'jpn', ka: 'kat', kk: 'kaz', km: 'khm',
  kn: 'kan', ko: 'kor', ku: 'kur', ky: 'kir', la: 'lat', lb: 'ltz', lo: 'lao', lt: 'lit',
  lv: 'lav', mk: 'mkd', ml: 'mal', mn: 'mon', mr: 'mar', ms: 'msa', mt: 'mlt', my: 'mya',
  nb: 'nob', ne: 'nep', nl: 'nld', nn: 'nno', no: 'nor', pa: 'pan', pl: 'pol', ps: 'pus',
  pt: 'por', ro: 'ron', ru: 'rus', si: 'sin', sk: 'slk', sl: 'slv', sq: 'sqi', sr: 'srp',
  sv: 'swe', sw: 'swa', ta: 'tam', te: 'tel', tg: 'tgk', th: 'tha', tl: 'tgl', tr: 'tur',
  uk: 'ukr', ur: 'urd', uz: 'uzb', vi: 'vie', yi: 'yid', zh: 'zho', zu: 'zul',
};

export function tvdbLanguage(tag: string | undefined): string {
  const { lang, region } = splitLanguageTag(tag);
  if (lang === 'pt' && region === 'BR') return 'pt';
  if (lang.length === 3) return lang;
  return ISO2_TO_3[lang] || 'eng';
}

export function languageChain(tag: string | undefined): string[] {
  const { lang } = splitLanguageTag(tag);
  return lang === 'en' ? ['en'] : [lang, 'en'];
}

export function tvdbLanguageChain(tag: string | undefined): string[] {
  const l = tvdbLanguage(tag);
  return l === 'eng' ? ['eng'] : [l, 'eng'];
}
