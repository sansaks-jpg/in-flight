# Aircraft 3D model credits

| File | Work | Author | License | Notes |
|---|---|---|---|---|
| `a320.glb` | Airbus A320-200 V2 | fDlruosne (Sketchfab) / FlightGear | CC-BY 4.0 | Rescaled at load time to the real 37.57 m x 34.10 m. Landing gear is added procedurally (the source model has none). |
| `c172.glb` | Cessna 172SP | NLM (NLM-Group, Sketchfab) | CC-BY 4.0 | Rescaled and registered to 8.28 m x 11.0 m. Propeller and wheels aligned with flight physics. |
| `atr72.glb` | "ATR 72 - 600" | Oyan3D (Sketchfab) | CC-BY 4.0 | Real-world metres (27.2 m x 26.9 m x 7.6 m). Propellers split out at load time. Fallback to procedural model if missing. |

## Provenance notes

- The original zip snapshots this project was recovered from never contained the `.glb` binaries. `c172.glb` and `a320.glb` were restored from the repository history (commit `d15e2bb`). `atr72.glb` was re-acquired via the [Godeye](https://github.com/Darksayd1224/Godeye) mirror of Oyan3D's Sketchfab model (CC-BY 4.0); that derivative strips textures, so the ATR 72 renders with flat materials. The propeller meshes (`Cylinder.024_Black_0`, `Cylinder.024_Yellow_0`) are preserved, which is what `glbAircraft.ts` splits to spin them.

