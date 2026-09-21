export interface Curated { id: number; name: string }

export const STUDIOS: Curated[] = [
  { id: 2, name: 'Walt Disney Pictures' }, { id: 3, name: 'Pixar' }, { id: 420, name: 'Marvel Studios' }, { id: 1, name: 'Lucasfilm' },
  { id: 174, name: 'Warner Bros. Pictures' }, { id: 33, name: 'Universal Pictures' }, { id: 4, name: 'Paramount' }, { id: 5, name: 'Columbia Pictures' },
  { id: 25, name: '20th Century Studios' }, { id: 21, name: 'Metro-Goldwyn-Mayer' }, { id: 1632, name: 'Lionsgate' }, { id: 12, name: 'New Line Cinema' },
  { id: 41077, name: 'A24' }, { id: 10342, name: 'Studio Ghibli' }, { id: 521, name: 'DreamWorks Animation' }, { id: 6704, name: 'Illumination' },
  { id: 923, name: 'Legendary Pictures' }, { id: 3172, name: 'Blumhouse' }, { id: 7505, name: 'Marvel Entertainment' }, { id: 9993, name: 'DC Entertainment' },
  { id: 2251, name: 'Sony Pictures Animation' }, { id: 19551, name: 'Searchlight Pictures' }, { id: 694, name: 'StudioCanal' }, { id: 856, name: 'Amblin Entertainment' },
  { id: 7295, name: 'Neon' }, { id: 11073, name: 'Sony Pictures Television' }, { id: 2348, name: 'Nickelodeon Animation Studio' }, { id: 3268, name: 'HBO' },
  { id: 41, name: 'Toho' }, { id: 10163, name: 'Working Title Films' }, { id: 306, name: 'Twisted Pictures' }, { id: 1, name: 'Lucasfilm Ltd.' },
];

export const NETWORKS: Curated[] = [
  { id: 213, name: 'Netflix' }, { id: 49, name: 'HBO' }, { id: 3186, name: 'HBO Max' }, { id: 2739, name: 'Disney+' }, { id: 2552, name: 'Apple TV+' },
  { id: 1024, name: 'Prime Video' }, { id: 453, name: 'Hulu' }, { id: 4330, name: 'Paramount+' }, { id: 3353, name: 'Peacock' }, { id: 174, name: 'AMC' },
  { id: 88, name: 'FX' }, { id: 67, name: 'Showtime' }, { id: 318, name: 'Starz' }, { id: 4, name: 'BBC One' }, { id: 332, name: 'BBC Two' },
  { id: 16, name: 'CBS' }, { id: 6, name: 'NBC' }, { id: 2, name: 'ABC' }, { id: 19, name: 'FOX' }, { id: 71, name: 'The CW' },
  { id: 80, name: 'Adult Swim' }, { id: 56, name: 'Cartoon Network' }, { id: 13, name: 'Nickelodeon' }, { id: 1112, name: 'Crunchyroll' }, { id: 98, name: 'Fuji TV' },
  { id: 57, name: 'TV Tokyo' }, { id: 2, name: 'ABC' }, { id: 1024, name: 'Prime Video' }, { id: 214, name: 'Sky' }, { id: 26, name: 'Channel 4' },
];

export const FRANCHISES: Curated[] = [
  { id: 86311, name: 'The Avengers' }, { id: 10, name: 'Star Wars' }, { id: 1241, name: 'Harry Potter' }, { id: 119, name: 'The Lord of the Rings' },
  { id: 121938, name: 'The Hobbit' }, { id: 645, name: 'James Bond' }, { id: 9485, name: 'Fast & Furious' }, { id: 328, name: 'Jurassic Park' },
  { id: 87359, name: 'Mission: Impossible' }, { id: 2344, name: 'The Matrix' }, { id: 84, name: 'Indiana Jones' }, { id: 10194, name: 'Toy Story' },
  { id: 2150, name: 'Shrek' }, { id: 263, name: 'The Dark Knight' }, { id: 8091, name: 'Alien' }, { id: 528, name: 'The Terminator' },
  { id: 1575, name: 'Rocky' }, { id: 295, name: 'Pirates of the Caribbean' }, { id: 131635, name: 'The Hunger Games' }, { id: 404609, name: 'John Wick' },
  { id: 556, name: 'Spider-Man' }, { id: 748, name: 'X-Men' }, { id: 8650, name: 'Transformers' }, { id: 86066, name: 'Despicable Me' },
  { id: 8354, name: 'Ice Age' }, { id: 264, name: 'Back to the Future' }, { id: 230, name: 'The Godfather' }, { id: 8945, name: 'Mad Max' },
  { id: 173710, name: 'Planet of the Apes' }, { id: 1570, name: 'Die Hard' }, { id: 304, name: "Ocean's" }, { id: 31562, name: 'The Bourne' },
  { id: 77816, name: 'Kung Fu Panda' }, { id: 89137, name: 'How to Train Your Dragon' }, { id: 87118, name: 'Cars' }, { id: 137697, name: 'Finding Nemo' },
  { id: 468222, name: 'The Incredibles' }, { id: 386382, name: 'Frozen' }, { id: 726871, name: 'Dune' }, { id: 87096, name: 'Avatar' },
  { id: 448150, name: 'Deadpool' }, { id: 284433, name: 'Guardians of the Galaxy' }, { id: 131295, name: 'Captain America' }, { id: 131292, name: 'Iron Man' },
  { id: 131296, name: 'Thor' }, { id: 422834, name: 'Ant-Man' }, { id: 422837, name: 'Blade Runner' }, { id: 2980, name: 'Ghostbusters' },
  { id: 86055, name: 'Men in Black' }, { id: 2602, name: 'Scream' }, { id: 91361, name: 'Halloween' }, { id: 656, name: 'Saw' },
  { id: 313086, name: 'The Conjuring' }, { id: 386534, name: 'Paddington' }, { id: 9735, name: 'Evil Dead' }, { id: 8581, name: 'A Nightmare on Elm Street' },
];

export const DECADES: Array<{ name: string; from: string; to: string }> = [
  { name: '2020s', from: '2020-01-01', to: '2029-12-31' }, { name: '2010s', from: '2010-01-01', to: '2019-12-31' }, { name: '2000s', from: '2000-01-01', to: '2009-12-31' },
  { name: '1990s', from: '1990-01-01', to: '1999-12-31' }, { name: '1980s', from: '1980-01-01', to: '1989-12-31' }, { name: '1970s', from: '1970-01-01', to: '1979-12-31' },
  { name: '1960s', from: '1960-01-01', to: '1969-12-31' }, { name: '1950s', from: '1950-01-01', to: '1959-12-31' }, { name: 'Classics', from: '1900-01-01', to: '1949-12-31' },
];

export function dedupe(list: Curated[]): Curated[] {
  const seen = new Set<number>();
  return list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}
