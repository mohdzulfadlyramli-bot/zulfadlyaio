import type { Env } from './env';
import type { RillConfig } from './config/schema';
import type { JellyfinProfile } from './config/schema';

export interface Ctx {
  cfg: RillConfig;
  env: Env;
  cfgToken: string;
  accountConfigToken?: string;
  origin: string;
  scope: string;
  cacheRevision?: string;
  profile?: JellyfinProfile;
  historyScope?: string;
  defer?: (work: Promise<unknown>) => void;
  queueOnly?: boolean;
  lang: string;
  tmdbKey: string | undefined;
}
