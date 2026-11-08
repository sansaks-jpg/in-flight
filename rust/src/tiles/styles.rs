//! Tile providers / map styles (port of `src/sim/tiles.ts` `TILE_STYLES` + `src/ui/mapLayers.ts` base layers).
//!
//! Only free, key-less providers are used. Esri is queried with `blankTile=false` so missing coverage answers
//! HTTP 404 (instead of a grey placeholder JPEG) and the renderer falls back to the last real parent tile.

#[derive(Clone, Copy, Debug)]
pub struct TileStyle {
    pub id: &'static str,
    pub name: &'static str,
    /// short label for the globe chip
    pub short: &'static str,
    pub url: &'static str,
    pub max_zoom: u8,
    pub attribution: &'static str,
    pub satellite: bool,
    /// emissive data set (night lights): drawn without day/night shading
    pub unlit: bool,
}

pub const STYLES: [TileStyle; 6] = [
    TileStyle {
        id: "sat",
        name: "Satellite Imagery",
        short: "SATELLITE",
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false",
        max_zoom: 18,
        attribution: "Imagery (c) Esri, Maxar, Earthstar Geographics",
        satellite: true,
        unlit: false,
    },
    TileStyle {
        id: "s2",
        name: "Sentinel-2 Cloudless",
        short: "SENTINEL-2",
        url: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg",
        max_zoom: 17,
        attribution: "Sentinel-2 cloudless by EOX (CC BY 4.0), Copernicus Sentinel data",
        satellite: true,
        unlit: false,
    },
    TileStyle {
        id: "osm",
        name: "OpenStreetMap",
        short: "STREETS",
        url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        max_zoom: 19,
        attribution: "(c) OpenStreetMap contributors (ODbL)",
        satellite: false,
        unlit: false,
    },
    TileStyle {
        id: "topo",
        name: "Terrain / Topographic",
        short: "TERRAIN",
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
        max_zoom: 18,
        attribution: "Esri, HERE, Garmin, USGS, NGA, (c) OpenStreetMap contributors",
        satellite: false,
        unlit: false,
    },
    TileStyle {
        id: "night",
        name: "Night Lights",
        short: "NIGHT",
        url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png",
        max_zoom: 8,
        attribution: "NASA Earth Observatory / VIIRS Black Marble (GIBS)",
        satellite: true,
        unlit: true,
    },
    TileStyle {
        id: "dark",
        name: "Dark Chart",
        short: "DARK",
        url: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        max_zoom: 19,
        attribution: "(c) OpenStreetMap contributors (c) CARTO",
        satellite: false,
        unlit: false,
    },
];

pub const DEFAULT_STYLE: u8 = 0;

pub fn style(id: u8) -> &'static TileStyle {
    &STYLES[(id as usize).min(STYLES.len() - 1)]
}

pub fn style_index(id: &str) -> Option<u8> {
    STYLES.iter().position(|s| s.id == id).map(|i| i as u8)
}

impl TileStyle {
    /// Expands the URL template (`{z}`, `{x}`, `{y}`); X wraps around the antimeridian like `tileUrl()` in the TS code.
    pub fn tile_url(&self, z: u8, x: u32, y: u32) -> String {
        let n = 1u64 << z;
        let xx = (x as u64) % n;
        self.url.replace("{z}", &z.to_string()).replace("{x}", &xx.to_string()).replace("{y}", &y.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_expand_like_the_typescript_reference() {
        let s = style(0);
        assert_eq!(s.tile_url(3, 3, 2), "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/3/2/3?blankTile=false");
        assert_eq!(style(2).tile_url(5, 17, 11), "https://tile.openstreetmap.org/5/17/11.png");
        assert_eq!(style(2).tile_url(2, 6, 1), "https://tile.openstreetmap.org/2/2/1.png"); // x wraps
    }

    #[test]
    fn style_table_is_consistent() {
        for (i, s) in STYLES.iter().enumerate() {
            assert_eq!(style_index(s.id), Some(i as u8));
            assert!(s.url.contains("{z}") && s.url.contains("{x}") && s.url.contains("{y}"), "{}", s.id);
            assert!(s.max_zoom >= 8);
            assert!(!s.attribution.is_empty());
        }
        assert!(STYLES[DEFAULT_STYLE as usize].satellite);
        assert!(STYLES.iter().any(|s| s.unlit && s.id == "night"));
    }
}
