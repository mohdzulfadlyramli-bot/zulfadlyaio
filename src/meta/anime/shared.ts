import type { ContentType } from '../../stremio/types';
import { sha256 } from '../../util/bytes';

export type AnimeKind = 'TV' | 'MOVIE' | 'OVA' | 'ONA' | 'SPECIAL' | 'MUSIC' | 'UNKNOWN';

export function animeKind(raw: string | null | undefined): AnimeKind {
  const s = String(raw || '').toUpperCase().replace(/[\s_-]+/g, '');
  if (!s) return 'UNKNOWN';
  if (s.startsWith('MOVIE')) return 'MOVIE';
  if (s.startsWith('TV') && s !== 'TVSPECIAL') return 'TV';
  if (s === 'TVSPECIAL' || s === 'SPECIAL') return 'SPECIAL';
  if (s === 'OVA') return 'OVA';
  if (s === 'ONA') return 'ONA';
  if (s === 'MUSIC' || s === 'PV' || s === 'CM') return 'MUSIC';
  return 'UNKNOWN';
}

export function stremioTypeFor(kind: AnimeKind): ContentType {
  return kind === 'MOVIE' ? 'movie' : 'series';
}

export function isSeriesKind(kind: AnimeKind): boolean {
  return kind !== 'MOVIE';
}

export function certFromMalRating(rating: string | null | undefined): string | undefined {
  if (!rating) return undefined;
  const head = rating.split(' - ')[0].trim().toUpperCase();
  switch (head) {
    case 'G': return 'G';
    case 'PG': return 'PG';
    case 'PG-13': return 'PG-13';
    case 'R': return 'R';
    case 'R+': return 'NC-17';
    case 'RX': return 'NC-17';
    default: return undefined;
  }
}

export function certFromKitsuRating(rating: string | null | undefined): string | undefined {
  switch (String(rating || '').toUpperCase()) {
    case 'G': return 'G';
    case 'PG': return 'PG';
    case 'R': return 'R';
    case 'R18': return 'NC-17';
    default: return undefined;
  }
}

export function certFromAnilist(isAdult: boolean | null | undefined): string | undefined {
  return isAdult ? 'NC-17' : undefined;
}

export function minutesFromJikanDuration(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const hr = /(\d+)\s*hr/i.exec(text);
  const min = /(\d+)\s*min/i.exec(text);
  const sec = /(\d+)\s*sec/i.exec(text);
  let total = 0;
  if (hr) total += Number(hr[1]) * 60;
  if (min) total += Number(min[1]);
  if (!hr && !min && sec) total = Math.max(1, Math.round(Number(sec[1]) / 60));
  return total > 0 ? total : undefined;
}

export function runtimeLabel(minutes: number | null | undefined): string | undefined {
  if (!minutes || minutes <= 0) return undefined;
  return `${Math.round(minutes)} min`;
}

export function stripHtml(html: string | null | undefined): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || undefined;
}

export function cleanSynopsis(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const cleaned = text.replace(/\s*\[Written by .*?\]\s*$/i, '').replace(/\s*\(Source: .*?\)\s*$/i, '').trim();
  return cleaned || undefined;
}

export function isoFromParts(parts: { year?: number | null; month?: number | null; day?: number | null } | null | undefined): string | undefined {
  if (!parts || !parts.year) return undefined;
  const m = String(parts.month || 1).padStart(2, '0');
  const d = String(parts.day || 1).padStart(2, '0');
  return `${parts.year}-${m}-${d}T00:00:00.000Z`;
}

export function isoDate(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const d = typeof value === 'number' ? new Date(value * (value < 1e12 ? 1000 : 1)) : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function yearOf(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const y = Number(iso.slice(0, 4));
  return Number.isFinite(y) && y > 1900 ? y : undefined;
}

export function releaseSpan(start: string | undefined, end: string | undefined, ongoing: boolean, movie: boolean): string | undefined {
  const a = yearOf(start);
  if (!a) return undefined;
  if (movie) return String(a);
  if (ongoing || !end) return ongoing ? `${a}-` : String(a);
  const b = yearOf(end);
  return b && b !== a ? `${a}-${b}` : String(a);
}

export function ratingLabel(value: number | null | undefined, scale: 10 | 100): string | undefined {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const ten = scale === 100 ? value / 10 : value;
  return ten.toFixed(1);
}

export interface SeasonStamp { season: 'winter' | 'spring' | 'summer' | 'fall'; year: number }

export function seasonStamp(date = new Date()): SeasonStamp {
  const m = date.getUTCMonth() + 1;
  const season = m <= 3 ? 'winter' : m <= 6 ? 'spring' : m <= 9 ? 'summer' : 'fall';
  return { season, year: date.getUTCFullYear() };
}

export function parseSeasonParam(value: string | undefined): SeasonStamp {
  const now = seasonStamp();
  if (!value) return now;
  const m = /(winter|spring|summer|fall|autumn)\s*(\d{4})|(\d{4})\s*(winter|spring|summer|fall|autumn)/i.exec(value);
  if (!m) return now;
  const s = (m[1] || m[4]).toLowerCase().replace('autumn', 'fall') as SeasonStamp['season'];
  const y = Number(m[2] || m[3]);
  return { season: s, year: y };
}

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

export function weekdayParam(value: string | undefined): (typeof WEEKDAYS)[number] {
  const v = String(value || '').toLowerCase();
  const hit = WEEKDAYS.find((d) => d === v || d.startsWith(v.slice(0, 3)) && v.length >= 3);
  if (hit) return hit;
  const idx = (new Date().getUTCDay() + 6) % 7;
  return WEEKDAYS[idx];
}

export async function stableHash(value: unknown): Promise<string> {
  return (await sha256(JSON.stringify(value))).slice(0, 24);
}

export function toInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function pageWindow(page: number, size: number): { skip: number; page: number } {
  const p = Math.max(1, Math.floor(page || 1));
  return { page: p, skip: (p - 1) * size };
}

export function dedupeStrings(items: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const it of items) {
    const s = (it || '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
