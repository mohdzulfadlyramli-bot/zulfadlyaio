import type { Ctx } from '../context';
import type { ClientInfo, Identity, TokenClaims } from './auth';

export interface JfRequest {
  ctx: Ctx;
  who: Identity;
  client: ClientInfo;
  claims: TokenClaims | null;
  accessToken?: string;
  base: string;
  rawPath: string;
  q: (name: string) => string | undefined;
  body: Record<string, unknown>;
}

export type JfEnv = { Variables: { jf: JfRequest; ctx: Ctx } };

export function qInt(jf: JfRequest, name: string, fallback: number): number {
  const n = parseInt(String(jf.q(name) ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function qBool(jf: JfRequest, name: string, fallback: boolean): boolean {
  const v = jf.q(name);
  return v === undefined ? fallback : v.toLowerCase() === 'true';
}

export function qList(jf: JfRequest, name: string): string[] {
  return String(jf.q(name) ?? '')
    .split(/[,|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
