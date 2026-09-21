
export interface NamedId { name: string; id: number }

export const TMDB_NETWORKS: NamedId[] = [
  { name: 'Netflix', id: 213 }, { name: 'HBO', id: 49 }, { name: 'Amazon', id: 1024 }, { name: 'Apple TV+', id: 2552 },
  { name: 'Disney+', id: 2739 }, { name: 'Hulu', id: 453 }, { name: 'Paramount+', id: 4330 }, { name: 'Peacock', id: 3353 },
  { name: 'Max', id: 3186 }, { name: 'AMC', id: 174 }, { name: 'FX', id: 88 }, { name: 'Showtime', id: 67 }, { name: 'Starz', id: 318 },
  { name: 'ABC', id: 2 }, { name: 'NBC', id: 6 }, { name: 'CBS', id: 16 }, { name: 'FOX', id: 19 }, { name: 'The CW', id: 71 },
  { name: 'USA Network', id: 30 }, { name: 'Syfy', id: 77 }, { name: 'Comedy Central', id: 47 }, { name: 'Adult Swim', id: 80 },
  { name: 'Cartoon Network', id: 56 }, { name: 'Nickelodeon', id: 13 }, { name: 'Discovery', id: 64 }, { name: 'National Geographic', id: 43 },
  { name: 'History', id: 65 }, { name: 'BBC One', id: 4 }, { name: 'BBC Two', id: 332 }, { name: 'ITV1', id: 9 }, { name: 'Channel 4', id: 26 },
  { name: 'Canal+', id: 285 }, { name: 'ZDF', id: 128 }, { name: 'Das Erste', id: 308 }, { name: 'Globo', id: 168 },
  { name: 'Crunchyroll', id: 1112 }, { name: 'Fuji TV', id: 3 }, { name: 'TV Tokyo', id: 94 }, { name: 'Nippon TV', id: 57 }, { name: 'Tokyo MX', id: 98 },
];

export const TMDB_KEYWORDS: NamedId[] = [
  { name: 'Superhero', id: 9715 }, { name: 'Anime', id: 210024 }, { name: 'Based on novel or book', id: 818 }, { name: 'Time travel', id: 4379 },
  { name: 'Zombie', id: 12377 }, { name: 'Vampire', id: 3133 }, { name: 'Heist', id: 10051 }, { name: 'Space', id: 9882 },
  { name: 'Coming of age', id: 10683 }, { name: 'Sequel', id: 9663 }, { name: 'Musical', id: 4344 }, { name: 'Female protagonist', id: 11322 },
  { name: 'Friendship', id: 6054 }, { name: 'Disaster', id: 10617 }, { name: 'Serial killer', id: 10714 }, { name: 'Murder', id: 9826 },
  { name: 'Dystopia', id: 4565 }, { name: 'Post-apocalyptic', id: 4458 }, { name: 'Martial arts', id: 779 }, { name: 'Alien', id: 9951 },
  { name: 'Robot', id: 14544 }, { name: 'Artificial intelligence', id: 310 }, { name: 'Magic', id: 2343 }, { name: 'Dragon', id: 10842 },
  { name: 'Road trip', id: 3149 }, { name: 'Slasher', id: 12339 }, { name: 'Found footage', id: 163053 }, { name: 'Monster', id: 1852 },
  { name: 'Spy', id: 470 }, { name: 'Revenge', id: 9748 }, { name: 'Kung fu', id: 780 }, { name: 'Christmas', id: 207317 },
  { name: 'High school', id: 6270 }, { name: 'Assassin', id: 5565 }, { name: 'Cyberpunk', id: 12190 }, { name: 'Mockumentary', id: 11800 },
];

export const TMDB_LANGUAGES: Array<{ name: string; code: string }> = [
  { name: 'English', code: 'en' }, { name: 'Spanish', code: 'es' }, { name: 'French', code: 'fr' }, { name: 'German', code: 'de' },
  { name: 'Italian', code: 'it' }, { name: 'Portuguese', code: 'pt' }, { name: 'Japanese', code: 'ja' }, { name: 'Korean', code: 'ko' },
  { name: 'Chinese', code: 'zh' }, { name: 'Hindi', code: 'hi' }, { name: 'Tamil', code: 'ta' }, { name: 'Telugu', code: 'te' },
  { name: 'Malayalam', code: 'ml' }, { name: 'Bengali', code: 'bn' }, { name: 'Russian', code: 'ru' }, { name: 'Ukrainian', code: 'uk' },
  { name: 'Turkish', code: 'tr' }, { name: 'Arabic', code: 'ar' }, { name: 'Persian', code: 'fa' }, { name: 'Hebrew', code: 'he' },
  { name: 'Swedish', code: 'sv' }, { name: 'Danish', code: 'da' }, { name: 'Norwegian', code: 'no' }, { name: 'Finnish', code: 'fi' },
  { name: 'Dutch', code: 'nl' }, { name: 'Polish', code: 'pl' }, { name: 'Czech', code: 'cs' }, { name: 'Hungarian', code: 'hu' },
  { name: 'Romanian', code: 'ro' }, { name: 'Greek', code: 'el' }, { name: 'Thai', code: 'th' }, { name: 'Indonesian', code: 'id' },
  { name: 'Vietnamese', code: 'vi' }, { name: 'Filipino', code: 'tl' },
];

export const STREAMING_PROVIDERS: Array<{ name: string; id: number; region: string }> = [
  { name: 'Netflix', id: 8, region: 'US' }, { name: 'Netflix Kids', id: 175, region: 'US' }, { name: 'Amazon Prime Video', id: 9, region: 'US' },
  { name: 'Disney+', id: 337, region: 'US' }, { name: 'Apple TV+', id: 350, region: 'US' }, { name: 'Max', id: 1899, region: 'US' },
  { name: 'Paramount+', id: 531, region: 'US' }, { name: 'Peacock', id: 386, region: 'US' }, { name: 'Hulu', id: 15, region: 'US' },
  { name: 'Crunchyroll', id: 283, region: 'US' }, { name: 'Hidive', id: 2390, region: 'US' }, { name: 'MUBI', id: 11, region: 'US' },
  { name: 'Starz', id: 43, region: 'US' }, { name: 'Criterion Channel', id: 258, region: 'US' }, { name: 'Discovery+', id: 584, region: 'US' },
  { name: 'BET+', id: 343, region: 'US' }, { name: 'Curiosity Stream', id: 190, region: 'US' }, { name: 'MagellanTV', id: 551, region: 'US' },
  { name: 'hayu', id: 223, region: 'GB' }, { name: 'Crave', id: 230, region: 'CA' }, { name: 'Canal+', id: 381, region: 'FR' },
  { name: 'WOW', id: 30, region: 'DE' }, { name: 'Sky Go', id: 29, region: 'GB' }, { name: 'SkyShowtime', id: 1773, region: 'NL' },
  { name: 'Videoland', id: 72, region: 'NL' }, { name: 'NLZIET', id: 472, region: 'NL' }, { name: 'Globoplay', id: 307, region: 'BR' },
  { name: 'Claro video', id: 167, region: 'BR' }, { name: 'JioHotstar', id: 2336, region: 'IN' }, { name: 'Sony LIV', id: 237, region: 'IN' },
  { name: 'ZEE5', id: 232, region: 'IN' }, { name: 'BluTV', id: 341, region: 'TR' },
];

export const AIRING_REGIONS = ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'NL', 'SE', 'PL', 'PT', 'BR', 'IN', 'JP', 'KR'];

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export const MAL_GENRES: NamedId[] = [
  { name: 'Action', id: 1 }, { name: 'Adventure', id: 2 }, { name: 'Comedy', id: 4 }, { name: 'Drama', id: 8 }, { name: 'Fantasy', id: 10 },
  { name: 'Horror', id: 14 }, { name: 'Mystery', id: 7 }, { name: 'Romance', id: 22 }, { name: 'Sci-Fi', id: 24 }, { name: 'Slice of Life', id: 36 },
  { name: 'Sports', id: 30 }, { name: 'Supernatural', id: 37 }, { name: 'Suspense', id: 41 }, { name: 'Award Winning', id: 46 },
  { name: 'Avant Garde', id: 5 }, { name: 'Gourmet', id: 47 }, { name: 'Boys Love', id: 28 }, { name: 'Girls Love', id: 26 }, { name: 'Ecchi', id: 9 },
  { name: 'Mecha', id: 18 }, { name: 'Music', id: 19 }, { name: 'Psychological', id: 40 }, { name: 'School', id: 23 }, { name: 'Military', id: 38 },
  { name: 'Isekai', id: 62 }, { name: 'Historical', id: 13 }, { name: 'Martial Arts', id: 17 }, { name: 'Space', id: 29 }, { name: 'Vampire', id: 32 },
  { name: 'Mythology', id: 6 }, { name: 'Super Power', id: 31 }, { name: 'Harem', id: 35 }, { name: 'Detective', id: 39 }, { name: 'Gore', id: 58 },
  { name: 'Iyashikei', id: 63 }, { name: 'Reincarnation', id: 72 }, { name: 'Time Travel', id: 78 }, { name: 'Survival', id: 76 },
  { name: 'Video Game', id: 79 }, { name: 'Workplace', id: 48 }, { name: 'Adult Cast', id: 50 }, { name: 'CGDCT', id: 52 }, { name: 'Parody', id: 20 },
  { name: 'Samurai', id: 21 }, { name: 'Mahou Shoujo', id: 66 }, { name: 'Organized Crime', id: 68 }, { name: 'Racing', id: 3 },
  { name: 'Strategy Game', id: 11 }, { name: 'Team Sports', id: 77 }, { name: 'Shounen', id: 27 }, { name: 'Shoujo', id: 25 },
  { name: 'Seinen', id: 42 }, { name: 'Josei', id: 43 }, { name: 'Kids', id: 15 },
];

export const MAL_STUDIOS: NamedId[] = [
  { name: 'MAPPA', id: 569 }, { name: 'Madhouse', id: 11 }, { name: 'Kyoto Animation', id: 2 }, { name: 'Bones', id: 4 }, { name: 'Wit Studio', id: 858 },
  { name: 'ufotable', id: 43 }, { name: 'A-1 Pictures', id: 56 }, { name: 'Production I.G', id: 10 }, { name: 'Sunrise', id: 14 },
  { name: 'Toei Animation', id: 18 }, { name: 'Studio Ghibli', id: 21 }, { name: 'CloverWorks', id: 1835 }, { name: 'Trigger', id: 803 },
  { name: 'Shaft', id: 44 }, { name: 'J.C.Staff', id: 7 }, { name: 'Studio Pierrot', id: 1 }, { name: 'Gainax', id: 6 }, { name: 'P.A. Works', id: 132 },
  { name: 'Kinema Citrus', id: 290 }, { name: 'David Production', id: 287 }, { name: 'Silver Link.', id: 300 }, { name: 'White Fox', id: 314 },
  { name: 'TMS Entertainment', id: 73 }, { name: 'Doga Kobo', id: 95 }, { name: 'Science SARU', id: 1978 }, { name: 'Studio Deen', id: 37 },
  { name: 'OLM', id: 28 }, { name: "Brain's Base", id: 112 }, { name: 'Lerche', id: 456 }, { name: 'Gonzo', id: 3 },
];

export const MAL_DECADES: Array<{ name: string; from: string; to: string }> = [
  { name: '2020s', from: '2020-01-01', to: '2029-12-31' },
  { name: '2010s', from: '2010-01-01', to: '2019-12-31' },
  { name: '2000s', from: '2000-01-01', to: '2009-12-31' },
  { name: '1990s', from: '1990-01-01', to: '1999-12-31' },
  { name: '1980s', from: '1980-01-01', to: '1989-12-31' },
];

export type AnimeSeason = 'winter' | 'spring' | 'summer' | 'fall';

export function seasonOf(date: Date): { season: AnimeSeason; year: number } {
  const m = date.getUTCMonth();
  const season: AnimeSeason = m <= 2 ? 'winter' : m <= 5 ? 'spring' : m <= 8 ? 'summer' : 'fall';
  return { season, year: date.getUTCFullYear() };
}

export function recentSeasonLabels(count: number, now = new Date()): string[] {
  const order: AnimeSeason[] = ['winter', 'spring', 'summer', 'fall'];
  let { season, year } = seasonOf(now);
  let idx = order.indexOf(season);
  idx += 1; if (idx > 3) { idx = 0; year += 1; }
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`${capitalize(order[idx])} ${year}`);
    idx -= 1; if (idx < 0) { idx = 3; year -= 1; }
  }
  return out;
}

export function parseSeasonLabel(label: string | undefined): { season: AnimeSeason; year: number } | null {
  const m = /^(winter|spring|summer|fall)\s+(\d{4})$/i.exec((label || '').trim());
  if (!m) return null;
  return { season: m[1].toLowerCase() as AnimeSeason, year: Number(m[2]) };
}

export function yearOptions(now = new Date()): string[] {
  const cur = now.getUTCFullYear();
  const years: string[] = [];
  for (let y = cur + 1; y >= 1950; y--) years.push(String(y));
  const decades: string[] = [];
  for (let d = Math.floor(cur / 10) * 10; d >= 1950; d -= 10) decades.push(`${d}s`);
  return [...years, ...decades];
}

export function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function regionOf(language: string): string {
  const part = (language || '').split('-')[1];
  return part && /^[A-Za-z]{2}$/.test(part) ? part.toUpperCase() : 'US';
}
