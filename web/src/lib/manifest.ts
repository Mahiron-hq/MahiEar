export interface Track {
  id: string;
  composer: string;
  work: string;
  part?: string;
  section?: string;
  duration: number;
  gain: number;
}

export interface Block {
  composer: string;
  work: string;
  tracks: string[];
}

export interface Manifest {
  version: string;
  tracks: Track[];
  blocks: Block[];
}

export interface Catalog {
  manifest: Manifest;
  byId: Map<string, Track>;
  blockOf: Map<string, number>;
  maxDuration: number;
}

const ID = /^[0-9a-f]{24}$/;

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length < 500;
}

export function parseManifest(raw: unknown): Manifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (!isStr(m.version) || !Array.isArray(m.tracks) || !Array.isArray(m.blocks)) return null;
  const tracks: Track[] = [];
  const ids = new Set<string>();
  for (const t of m.tracks as unknown[]) {
    if (!t || typeof t !== 'object') return null;
    const r = t as Record<string, unknown>;
    if (!isStr(r.id) || !ID.test(r.id) || ids.has(r.id) || !isStr(r.composer) || !isStr(r.work)) return null;
    if (typeof r.duration !== 'number' || !(r.duration > 0) || typeof r.gain !== 'number' || !Number.isFinite(r.gain))
      return null;
    if (r.part !== undefined && !isStr(r.part)) return null;
    if (r.section !== undefined && !isStr(r.section)) return null;
    ids.add(r.id);
    tracks.push({
      id: r.id,
      composer: r.composer,
      work: r.work,
      ...(r.part ? { part: r.part as string } : {}),
      ...(r.section ? { section: r.section as string } : {}),
      duration: r.duration,
      gain: r.gain,
    });
  }
  const blocks: Block[] = [];
  const inBlock = new Set<string>();
  for (const b of m.blocks as unknown[]) {
    if (!b || typeof b !== 'object') return null;
    const r = b as Record<string, unknown>;
    if (!isStr(r.composer) || !isStr(r.work) || !Array.isArray(r.tracks) || r.tracks.length === 0) return null;
    for (const id of r.tracks) {
      if (typeof id !== 'string' || !ids.has(id) || inBlock.has(id)) return null;
      inBlock.add(id);
    }
    blocks.push({ composer: r.composer, work: r.work, tracks: r.tracks as string[] });
  }
  if (inBlock.size !== ids.size) return null;
  return { version: m.version, tracks, blocks };
}

export function catalog(manifest: Manifest): Catalog {
  const byId = new Map(manifest.tracks.map((t) => [t.id, t]));
  const blockOf = new Map<string, number>();
  manifest.blocks.forEach((b, i) => b.tracks.forEach((id) => blockOf.set(id, i)));
  const maxDuration = manifest.tracks.reduce((m, t) => Math.max(m, t.duration), 0);
  return { manifest, byId, blockOf, maxDuration };
}

export function titleLevels(t: Track): string[] {
  return [t.composer, t.work, t.part, t.section].filter((x): x is string => !!x);
}

export function fullTitle(t: Track): string {
  return titleLevels(t).join(' · ');
}

export function audioUrl(id: string): string {
  return `/a/${id}.mp3`;
}
