// Zero-dependency Mapbox Vector Tile (.pbf / Protobuf) decoder.
// Fetches vector tiles from OpenFreeMap Cloudflare CDN (<80ms worldwide, 100% free)
// and extracts 1:1 building footprints, highways/roads, forest polygons, and water bodies.
import { tileXToLon, tileYToLat } from './geo';

export type LL = [number, number]; // [lat, lon]

export interface MvtBuilding {
  ring: LL[];
  height: number;
  minHeight: number;
  /** Only present when the tile actually carries a `colour` tag; most do not. */
  color?: number;
  type?: string;
  area: number;
  /** True when the tile carried no height at all and `height` is a plausible stand-in. */
  synthetic: boolean;
}

export interface MvtRoad {
  points: LL[];
  highway: string;
  /** OSM `layer` (bridges / stacked ramps). Positive values lift the ribbon off the ground. */
  layer: number;
  /** `bridge` / `tunnel` / `ford` when present. */
  brunnel: string;
}

export interface MvtPolygon {
  ring: LL[];
  type: string;
}

export interface MvtTileData {
  buildings: MvtBuilding[];
  roads: MvtRoad[];
  forests: MvtPolygon[];
  water: MvtPolygon[];
  /** Built-up landuse polygons (residential / commercial / industrial), used for scenery infill. */
  urban: MvtPolygon[];
}

// ---- Protobuf Decoder ----
class PbfReader {
  pos = 0;
  constructor(public buf: Uint8Array, public end = buf.length) {}

  hasMore(): boolean {
    return this.pos < this.end;
  }

  readVarint(): number {
    let res = 0, shift = 0;
    while (this.pos < this.end) {
      const b = this.buf[this.pos++];
      res += (b & 0x7f) * Math.pow(2, shift);
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return res;
  }

  readSVarint(): number {
    const num = this.readVarint();
    return (num % 2 === 1) ? -(num + 1) / 2 : num / 2;
  }

  readFloat(): number {
    if (this.pos + 4 > this.end) return 0;
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4);
    this.pos += 4;
    return view.getFloat32(0, true);
  }

  readDouble(): number {
    if (this.pos + 8 > this.end) return 0;
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getFloat64(0, true);
  }

  readString(len: number): string {
    const end = Math.min(this.end, this.pos + len);
    const sub = this.buf.subarray(this.pos, end);
    this.pos = end;
    return new TextDecoder().decode(sub);
  }

  readBytes(len: number): Uint8Array {
    const end = Math.min(this.end, this.pos + len);
    const sub = this.buf.subarray(this.pos, end);
    this.pos = end;
    return sub;
  }

  skip(wire: number) {
    if (wire === 0) {
      this.readVarint();
    } else if (wire === 1) {
      this.pos = Math.min(this.end, this.pos + 8);
    } else if (wire === 2) {
      const len = this.readVarint();
      this.pos = Math.min(this.end, this.pos + len);
    } else if (wire === 5) {
      this.pos = Math.min(this.end, this.pos + 4);
    } else {
      this.pos = this.end; // Unrecognized wire type: terminate safely
    }
  }
}

// Calculate approximate area of a ring in square meters
export function areaM2(ring: LL[]): number {
  if (ring.length < 3) return 0;
  let lat0 = 0, lon0 = 0;
  for (const [la, lo] of ring) { lat0 += la; lon0 += lo; }
  lat0 /= ring.length; lon0 /= ring.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const ax = (a[1] - lon0) * kx, ay = (a[0] - lat0) * 110574;
    const bx = (b[1] - lon0) * kx, by = (b[0] - lat0) * 110574;
    sum += ax * by - bx * ay;
  }
  return Math.abs(sum) / 2;
}

// Parse hex or named color to RGB number
function parseColor(val: unknown): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    if (val.startsWith('#')) {
      const hex = parseInt(val.slice(1, 7), 16);
      if (!isNaN(hex)) return hex;
    }
  }
  return 0xd5cfc6; // Default warm concrete
}

// Zigzag decode
function decodeZigZag(n: number): number {
  return (n >>> 1) ^ (-(n & 1));
}

// Decode geometry commands from MVT packed buffer
function decodeGeometry(
  geom: number[],
  _type: number,
  extent: number,
  z: number,
  tx: number,
  ty: number
): LL[][] {
  const rings: LL[][] = [];
  let curRing: LL[] = [];
  let cx = 0, cy = 0;
  let i = 0;

  while (i < geom.length) {
    const cmdInt = geom[i++];
    const cmdId = cmdInt & 0x7;
    const count = cmdInt >> 3;

    if (cmdId === 1) { // MoveTo
      for (let c = 0; c < count; c++) {
        cx += decodeZigZag(geom[i++]);
        cy += decodeZigZag(geom[i++]);
        if (curRing.length > 0) {
          rings.push(curRing);
        }
        const lon = tileXToLon(tx + cx / extent, z);
        const lat = tileYToLat(ty + cy / extent, z);
        curRing = [[lat, lon]];
      }
    } else if (cmdId === 2) { // LineTo
      for (let c = 0; c < count; c++) {
        cx += decodeZigZag(geom[i++]);
        cy += decodeZigZag(geom[i++]);
        const lon = tileXToLon(tx + cx / extent, z);
        const lat = tileYToLat(ty + cy / extent, z);
        curRing.push([lat, lon]);
      }
    } else if (cmdId === 7) { // ClosePath
      if (curRing.length > 2) {
        // Ensure ring is closed
        const first = curRing[0];
        const last = curRing[curRing.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
          curRing.push([first[0], first[1]]);
        }
        rings.push(curRing);
      }
      curRing = [];
    }
  }

  if (curRing.length > 1) {
    rings.push(curRing);
  }

  return rings;
}

// Raw Feature parsed from Layer
interface RawFeature {
  tags: number[];
  type: number;
  geometry: number[];
}

interface RawLayer {
  name: string;
  extent: number;
  keys: string[];
  values: unknown[];
  features: RawFeature[];
}

function parseLayer(pbf: PbfReader, end: number): RawLayer {
  const layer: RawLayer = {
    name: '',
    extent: 4096,
    keys: [],
    values: [],
    features: [],
  };

  while (pbf.pos < end) {
    const tag = pbf.readVarint();
    const field = tag >> 3;
    const wire = tag & 0x7;

    if (field === 1 && wire === 2) {
      const len = pbf.readVarint();
      layer.name = pbf.readString(len);
    } else if (field === 3 && wire === 2) { // keys
      const len = pbf.readVarint();
      layer.keys.push(pbf.readString(len));
    } else if (field === 4 && wire === 2) { // values
      const len = pbf.readVarint();
      const valEnd = pbf.pos + len;
      let val: unknown = null;
      while (pbf.pos < valEnd) {
        const vtag = pbf.readVarint();
        const vfield = vtag >> 3;
        const vwire = vtag & 0x7;
        if (vfield === 1 && vwire === 2) {
          val = pbf.readString(pbf.readVarint());
        } else if (vfield === 2 && vwire === 5) {
          val = pbf.readFloat();
        } else if (vfield === 3 && vwire === 1) {
          val = pbf.readDouble();
        } else if (vfield === 4 && vwire === 0) {
          val = pbf.readVarint();
        } else if (vfield === 5 && vwire === 0) {
          val = pbf.readVarint();
        } else if (vfield === 6 && vwire === 0) {
          val = pbf.readSVarint();
        } else if (vfield === 7 && vwire === 0) {
          val = pbf.readVarint() !== 0;
        } else {
          pbf.skip(vwire);
        }
      }
      pbf.pos = valEnd;
      layer.values.push(val);
    } else if (field === 5 && wire === 0) { // extent
      layer.extent = pbf.readVarint();
    } else if (field === 2 && wire === 2) { // features
      const flen = pbf.readVarint();
      const fend = pbf.pos + flen;
      const feat: RawFeature = { tags: [], type: 0, geometry: [] };
      while (pbf.pos < fend) {
        const ftag = pbf.readVarint();
        const ffield = ftag >> 3;
        const fwire = ftag & 0x7;
        if (ffield === 2 && fwire === 2) { // tags (packed uint32)
          const tlen = pbf.readVarint();
          const tend = pbf.pos + tlen;
          while (pbf.pos < tend) {
            feat.tags.push(pbf.readVarint());
          }
        } else if (ffield === 3 && fwire === 0) { // type
          feat.type = pbf.readVarint();
        } else if (ffield === 4 && fwire === 2) { // geometry (packed uint32)
          const glen = pbf.readVarint();
          const gend = pbf.pos + glen;
          while (pbf.pos < gend) {
            feat.geometry.push(pbf.readVarint());
          }
        } else {
          pbf.skip(fwire);
        }
      }
      pbf.pos = fend;
      layer.features.push(feat);
    } else {
      pbf.skip(wire);
    }
  }

  return layer;
}

/** Decodes a binary Mapbox Vector Tile buffer (.pbf) */
export function decodeMvt(buffer: ArrayBuffer, z: number, x: number, y: number): MvtTileData {
  const result: MvtTileData = {
    buildings: [],
    roads: [],
    forests: [],
    water: [],
    urban: [],
  };

  const pbf = new PbfReader(new Uint8Array(buffer));

  while (pbf.hasMore()) {
    const tag = pbf.readVarint();
    const field = tag >> 3;
    const wire = tag & 0x7;

    if (field === 3 && wire === 2) { // Layer
      const len = pbf.readVarint();
      const end = pbf.pos + len;
      const layer = parseLayer(pbf, end);
      pbf.pos = end;

      const getProps = (feat: RawFeature): Record<string, unknown> => {
        const props: Record<string, unknown> = {};
        for (let i = 0; i < feat.tags.length; i += 2) {
          const kIdx = feat.tags[i];
          const vIdx = feat.tags[i + 1];
          if (kIdx < layer.keys.length && vIdx < layer.values.length) {
            props[layer.keys[kIdx]] = layer.values[vIdx];
          }
        }
        return props;
      };

      if (layer.name === 'building') {
        for (const feat of layer.features) {
          if (feat.type !== 3) continue; // Polygon
          const rings = decodeGeometry(feat.geometry, feat.type, layer.extent, z, x, y);
          if (!rings.length) continue;
          const props = getProps(feat);
          const rawType = String(props.class || props.subclass || props.building || props.type || '').toLowerCase();
          const type = rawType && rawType !== 'yes' ? rawType : undefined;
          let h = typeof props.render_height === 'number' ? props.render_height : 0;
          if (!h && typeof props.levels === 'number') h = props.levels * 3.2 + 1.0;
          if (!h && typeof props.height === 'number') h = props.height;
          let synthetic = false;
          if (!h || h < 2) {
            // OSM/OpenFreeMap carries no height for the vast majority of Indonesian houses. A single
            // global default made every one of them exactly the same height, so the housing sprawl
            // read as a flat red carpet next to the towers. Give each footprint a deterministic
            // height keyed on typology and footprint area so warehouses, shophouses and houses differ.
            synthetic = true;
            const p0 = rings[0][0] ?? [0, 0];
            const rnd = Math.abs(Math.sin(p0[0] * 12.9898 + p0[1] * 78.233) * 43758.5453) % 1;
            const footprint = areaM2(rings[0]);
            if (type && /^(industrial|warehouse|hangar|factory|manufacture|shed|barn|garages)/.test(type)) {
              h = 6.2 + rnd * 5.2;
            } else if (type && /^(apartments|hotel|office|hospital|university|commercial)/.test(type)) {
              h = footprint > 320 ? 14.0 + rnd * 18.0 : 9.5 + rnd * 8.5;
            } else if (footprint > 650) {
              // Large un-tagged footprint: typically a warehouse, market hall, or school block
              h = 6.8 + rnd * 5.4;
            } else if (footprint > 200) {
              // Ruko (shophouse) row or mid-size commercial block (2-4 storeys)
              h = 7.8 + rnd * 6.8;
            } else {
              // Landed house (1-2 storeys)
              h = 3.8 + rnd * 4.2;
            }
          }
          const minH = typeof props.render_min_height === 'number' ? props.render_min_height : 0;
          // Leave colour undefined when the tile has no `colour` tag: the renderer then assigns a
          // deterministic facade palette instead of painting every building the same beige.
          const colourRaw = props.colour;
          const color = colourRaw === undefined || colourRaw === null ? undefined : parseColor(colourRaw);

          for (const ring of rings) {
            const area = areaM2(ring);
            if (area < 15) continue;
            result.buildings.push({
              ring,
              height: Math.max(3, Math.min(380, h)),
              minHeight: Math.max(0, minH),
              color,
              type,
              area,
              synthetic,
            });
          }
        }
      } else if (layer.name === 'transportation') {
        for (const feat of layer.features) {
          if (feat.type !== 2) continue; // LineString
          const props = getProps(feat);
          const hwClass = String(props.class || props.subclass || '');
          if (!/^(motorway|trunk|primary|secondary|tertiary|motorway_link|primary_link)/.test(hwClass)) continue;
          // Bridges and stacked expressway ramps carry a positive `layer`; without it every flyover
          // was flattened onto the same plane and the interchanges read as a tangle of grey ribbons.
          const rawLayer = typeof props.layer === 'number' ? props.layer : Number(props.layer);
          const layerNo = Number.isFinite(rawLayer) ? Math.max(-2, Math.min(6, rawLayer)) : 0;
          const brunnel = typeof props.brunnel === 'string' ? props.brunnel : '';
          const lines = decodeGeometry(feat.geometry, feat.type, layer.extent, z, x, y);
          for (const line of lines) {
            if (line.length >= 2) {
              result.roads.push({ points: line, highway: hwClass, layer: layerNo, brunnel });
            }
          }
        }
      } else if (layer.name === 'landcover' || layer.name === 'landuse' || layer.name === 'park') {
        for (const feat of layer.features) {
          if (feat.type !== 3) continue; // Polygon
          const props = getProps(feat);
          const cls = String(props.class || props.subclass || '');
          if (/^(wood|forest|scrub|grass|park|orchard|village_green|garden|nature_reserve|cemetery|recreation_ground)/.test(cls)) {
            const rings = decodeGeometry(feat.geometry, feat.type, layer.extent, z, x, y);
            for (const ring of rings) {
              if (ring.length >= 3 && areaM2(ring) > 200) {
                result.forests.push({ ring, type: cls });
              }
            }
          } else if ((layer.name === 'landuse' || layer.name === 'park') && /^(residential|commercial|industrial|retail|construction|brownfield|quarry)/.test(cls)) {
            // Built-up land. Indonesian OSM maps only a fraction of the individual houses, so these
            // polygons are what lets the renderer fill the "empty" looking districts with plausible
            // low-rise fabric instead of leaving bare satellite texture.
            const rings = decodeGeometry(feat.geometry, feat.type, layer.extent, z, x, y);
            for (const ring of rings) {
              if (ring.length >= 3 && areaM2(ring) > 1500) {
                result.urban.push({ ring, type: cls });
              }
            }
          }
        }
      } else if (layer.name === 'water' || layer.name === 'waterway') {
        for (const feat of layer.features) {
          if (feat.type !== 3) continue; // Polygon
          const rings = decodeGeometry(feat.geometry, feat.type, layer.extent, z, x, y);
          for (const ring of rings) {
            if (ring.length >= 3 && areaM2(ring) > 100) {
              result.water.push({ ring, type: 'water' });
            }
          }
        }
      }
    } else {
      pbf.skip(wire);
    }
  }

  return result;
}

// ---- OpenFreeMap Tile Fetcher with Dynamic Planet URL Resolution & Cache ----
const tileCache = new Map<string, MvtTileData>();
const CACHE_LIMIT = 150;

let planetTemplatePromise: Promise<string | null> | null = null;
let planetTemplate: string | null = null;

export async function getPlanetTileTemplate(): Promise<string | null> {
  if (planetTemplate) return planetTemplate;
  if (!planetTemplatePromise) {
    planetTemplatePromise = (async () => {
      try {
        const res = await fetch('https://tiles.openfreemap.org/planet/latest', {
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) return null;
        const meta = await res.json();
        if (meta && Array.isArray(meta.tiles) && meta.tiles.length > 0) {
          planetTemplate = meta.tiles[0];
          return planetTemplate;
        }
      } catch {
        // network / offline
      }
      return null;
    })();
  }
  return planetTemplatePromise;
}

export async function fetchMvtTile(z: number, x: number, y: number): Promise<MvtTileData | null> {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key)!;

  try {
    const tpl = await getPlanetTileTemplate();
    const url = tpl
      ? tpl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
      : `https://tiles.openfreemap.org/planet/${z}/${x}/${y}.pbf`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/x-protobuf' },
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) {
      const emptyData: MvtTileData = { buildings: [], roads: [], forests: [], water: [], urban: [] };
      tileCache.set(key, emptyData);
      return emptyData;
    }
    const data = decodeMvt(buf, z, x, y);

    if (tileCache.size >= CACHE_LIMIT) {
      const first = tileCache.keys().next().value;
      if (first) tileCache.delete(first);
    }
    tileCache.set(key, data);
    return data;
  } catch {
    return null;
  }
}
