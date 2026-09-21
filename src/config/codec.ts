import { normalizeConfig, type RillConfig } from './schema';
import { b64urlDecode, b64urlEncode } from '../util/bytes';

const PREFIX = 'c1.';
const decoded = new Map<string, RillConfig>();

export async function encodeConfig(cfg: RillConfig): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(cfg));
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  void w.write(json); void w.close();
  const out = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  return PREFIX + b64urlEncode(out);
}

export async function decodeConfig(token: string): Promise<RillConfig | null> {
  try {
    const cached = decoded.get(token);
    if (cached) return structuredClone(cached);
    let json: string;
    if (token.startsWith(PREFIX)) {
      const bytes = b64urlDecode(token.slice(PREFIX.length));
      const ds = new DecompressionStream('deflate-raw');
      const w = ds.writable.getWriter();
      void w.write(bytes); void w.close();
      json = await new Response(ds.readable).text();
    } else json = new TextDecoder().decode(b64urlDecode(token));
    const cfg = normalizeConfig(JSON.parse(json));
    if (token.length <= 65536 && json.length <= 262144) {
      if (decoded.size >= 8) decoded.delete(decoded.keys().next().value!);
      decoded.set(token, structuredClone(cfg));
    }
    return cfg;
  } catch {
    return null;
  }
}
