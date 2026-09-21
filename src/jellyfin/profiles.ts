import type { Ctx } from '../context';
import { identityOf } from './auth';

export function profileContext(ctx: Ctx, id?: string): Ctx | null {
  if (!id) return { ...ctx,profile:undefined,historyScope:undefined };
  const profile = ctx.cfg.jellyfin.profiles?.find(p => p.id === id);
  if (!profile) return null;
  return { ...ctx,profile,historyScope:profile.sharesHistory ? ctx.scope : `${ctx.scope}:profile:${profile.id}`,
    cfg:profile.ageCap ? {...ctx.cfg,ageCap:profile.ageCap} : ctx.cfg };
}

export async function profileUsers(ctx: Ctx): Promise<Array<{ctx:Ctx;who:Awaited<ReturnType<typeof identityOf>>}>> {
  const main = profileContext(ctx)!;
  return Promise.all([main,...(ctx.cfg.jellyfin.profiles ?? []).map(p => profileContext(main,p.id)!)].map(async c => ({ctx:c,who:await identityOf(c)})));
}
