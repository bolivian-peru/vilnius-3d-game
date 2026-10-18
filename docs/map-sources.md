**Vilnius map sources and acquisition**

Checked 13 October 2026. The rankings below are engineering recommendations based on provider documentation and catalogs. One 500 m tile of the municipal 2022 mesh and the Lithuania OSM extract have since been downloaded and built; nothing has been benchmarked in Unreal.

**The recommended source combination**

| Source | Evidence found | Recommended role | Outstanding check |
| --- | --- | --- | --- |
| [3D Vilnius / ID Vilnius](https://idvilnius.lt/en/projects/3d-models-of-vilnius-city/) | Official realistic city model, building model, and oblique aerial imagery | First candidate for city appearance, roof shapes, and distant scenery | Obtain sample, coverage, capture dates, source formats, and game redistribution terms |
| [Municipal 3D services](https://opencity.idvilnius.lt/server/rest/services/3D) | Directory lists 2019 and 2022 meshes | Locate the relevant city mesh and ask whether a newer survey exists | Service names alone do not prove survey dates, complete coverage, or export permission |
| [National LiDAR, Lidar_DR_LT](https://data.gov.lt/datasets/3987/) | Current catalog covers 2019–2026, with classified LAZ tiles | Terrain, ground elevations, building-height estimation, tree-height reference | Check the actual acquisition year and vertical reference of each Vilnius tile and applicable use terms |
| [GRPK open data](https://data.gov.lt/datasets/3424/) | National geographic base data, with CC BY 4.0 reuse terms | Building footprints, hydrography, transport geometry, land cover, stable identifiers | Inspect actual layer schemas, local accuracy, and feature completeness |
| [OSM through Geofabrik](https://download.geofabrik.de/europe/lithuania.html) | Downloadable Lithuania PBF under ODbL | Street topology, names, access rules, turn restrictions, and mapped lane tags | Audit missing widths, lanes, restrictions, and recent changes on playable routes |
| [Vilnius heritage digitization](https://vilnius.lt/naujienos/vilnius-pasitelkia-dirbtini-intelekta-istoriniam-miesto-paveldui-saugoti) | March 2026 announcement describes digitization of 15 ha in the Old Town | Possible higher-detail source for selected historic buildings | Identify exact area, available deliverables, and reuse rights |
| [Anyscape Vilnius](https://anyscape.io/3d-city-models/vilnius/) | Vendor offers city exports, including Blender/FBX/Unreal options | Paid shortcut for a geographic blockout if its sample passes inspection | Confirm exact coverage, source attribution, shipping license, and cleanup work |

**What to obtain first**

Open the [realistic municipal viewer](https://3d.vilnius.lt/scenos/realaus-vaizdo-3d-modelis), then evaluate these catalog leads:

- [2022 mesh SceneServer](https://opencity.idvilnius.lt/server/rest/services/3D/Vilnius_mesh_2022/SceneServer).
- [2019 mesh SceneServer](https://opencity.idvilnius.lt/server/rest/services/3D/Vilnius_mesh_2019/SceneServer).
- [Municipal buildings SceneServer](https://opencity.idvilnius.lt/server/rest/services/Hosted/Pastatai_3D/SceneServer).

Later on 13 October the endpoints answered scripted requests with a browser-like user agent. `Vilnius_mesh_2022` is an I3S 1.9 integrated mesh in EPSG:3857 with Draco geometry and JPEG textures, described by the service as a Bentley ContextCapture reality mesh. Its capabilities are View and Query. It states no copyright text, no capture date, and no vertical datum. The pilot tile at Žaliasis tiltas holds 262 finest-level nodes and 4.7 million triangles, and river and bridge-deck heights (about 85 m and 96 m) are plausible for Vilnius.

`pipeline/vilnius_pipeline/i3s.py` fetches one tile at a time for local evaluation. That is a way to judge the data, not permission to ship it. Ask ID Vilnius for an authorized export and terms before any mesh-derived asset is distributed, and do not bulk-download the city from the public service.

For a municipal sample, prefer original textured mesh tiles with metadata. Useful deliverables include OBJ/FBX/glTF with texture folders, or an I3S/SLPK or 3D Tiles package. These formats need different import paths. Request a sample before deciding whether conversion or runtime streaming is practical.

[ArcGIS Maps SDK for Unreal](https://developers.arcgis.com/unreal-engine/layers/) supports integrated mesh scene layers and local scene packages. It is a reasonable evaluation route for I3S. Cesium is an alternative for a suitable 3D Tiles delivery. Neither plugin grants rights to the underlying city data, and a streamed scene is not automatically editable Blender geometry.

The current LiDAR catalog specifies at least 6.5 points/m², horizontal RMSE up to 30 cm and vertical RMSE up to 10 cm on stable hard objects. Those are dataset specifications, not guaranteed accuracy for every generated road or building. Automatic classification can contain errors. Recent RIEGL files can also contain extra dimensions that older readers do not accept. Preserve original files and check a sample in PDAL before processing a district. [LiDAR catalog](https://data.gov.lt/datasets/3987/).

National data access is described by [NŽT](https://nzt.lrv.lt/lt/naujienos/kaip-gauti-valstybinius-erdvinius-duomenis-CkKP/): users can register with Geoportal, select data and parameters, and download prepared orders. Large deliveries can require a separate request. Availability without a fee does not settle the terms of every layer.

The GRPK publisher provides [SHP](https://www.geoportal.lt/download/opendata/GRPK/GRPK_Open_SHP.zip) and [File Geodatabase](https://www.geoportal.lt/download/opendata/GRPK/GRPK_Open_GDB.zip) download links. Obtain one format and clip locally; keep its attribution and modification record. These archive links were found in the publisher's catalog, but the archives were not downloaded in this research. [GRPK catalog](https://data.gov.lt/datasets/3424/).

For OSM, use the Lithuania PBF and preserve nodes, ways, and relations. A convenient line export alone is insufficient for a traffic system because it may omit turn restrictions and relation membership. Check relation completeness after extracting a buffered city area. [Geofabrik](https://download.geofabrik.de/europe/lithuania.html), [Osmium extraction documentation](https://docs.osmcode.org/osmium/latest/osmium-extract.html).

**How to judge quality**

Evaluate the same 500 m tile from each candidate, at pedestrian eye level and from a driving camera. Inspect facades, underpasses, bridge decks, roof edges, courtyards, tree artifacts, texture seams, and baked vehicles. Measure geometric alignment against independent control points and recent authorized imagery. Record both capture date and download date.

A photogrammetric mesh can contain connected buildings and trees, baked shadows, indistinct pavement, or missing surfaces under bridges. Check for these defects in the actual sample. Plan to replace the driving surface with clean geometry and retain useful scan detail where it holds up.

Anyscape's Vilnius page identifies a 2021 catalog build, computed LoD1 buildings, and a 30 m terrain source. My assessment is that this could accelerate a blockout, but it does not establish the facade or road-surface quality needed for close gameplay. Require a sample with separate objects, real roof detail where promised, texture information, coordinate metadata, and a commercial game distribution license. Do not treat the listing's “Unreal Engine” format option as proof of collision, traffic, or optimization. [Vendor listing](https://anyscape.io/3d-city-models/vilnius/).

Google's photorealistic tiles are unsuitable as our default offline asset source. Its published policies restrict extraction, storage, and offline use outside the applicable agreement. A Blender importer does not resolve those restrictions. A licensed visualization experiment is a separate use case. [Google Map Tiles policies](https://developers.google.com/maps/documentation/tile/policies).

OSM requires attribution and ODbL compliance. Track OSM-derived databases separately from independently authored art and code. Whether an exported artifact is a database or a produced work depends on its content and use; do not assume either that the whole game must be open source or that every generated file is exempt. [OSM copyright](https://www.openstreetmap.org/copyright), [OSMF produced-work guidance](https://osmfoundation.org/wiki/Licence/Community_Guidelines/Produced_Work_-_Guideline).

**Draft request to ID Vilnius, ready for the owner to send**

This request has not been sent.

> Kuriame kompiuterinį žaidimą „Unreal Engine“, kuriame norime atkurti realų Vilniaus gatvių tinklą ir miesto aplinką. Norėtume įvertinti naujausią turimą tekstūruotą 3D miesto modelį ir atskirų pastatų geometriją.
>
> Ar galėtumėte pateikti duomenų aprėptį, faktines fotografavimo / skenavimo datas, geometrinį tikslumą, tekstūrų raišką, koordinačių bei aukščių sistemas ir galimus eksporto formatus? Pradiniam bandymui reikėtų maždaug 500 × 500 m centrinės miesto dalies fragmento.
>
> Taip pat prašome nurodyti licencijos ir kainodaros sąlygas. Mums reikalinga teisė redaguoti, optimizuoti ir įtraukti išvestinius modelius bei tekstūras į komercinio žaidimo diegimo paketus, veikiančius ir be interneto, bei naudoti žaidimo vaizdus reklamoje. Ar šias teises galima suteikti ir kokie autorystės nurodymo reikalavimai?
>
> Ar prieinami naujesni nei 2022 m. miesto modelio duomenys, klasifikuotas LiDAR, ortofoto, įstrižos nuotraukos, kelių dangų ribos ar eismo juostų geometrija?

The next acquisition decision is whether the municipal delivery adds enough usable detail to justify licensing and cleanup. If it does not, continue with the documented open-data layers and authored facades. The street pipeline should work with either outcome.
