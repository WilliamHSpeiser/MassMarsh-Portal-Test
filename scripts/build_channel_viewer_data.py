#!/usr/bin/env python3
"""Channel Viewer data (experimental portal page, massmarsh/tool-channel.js): the statewide channel polygons of one lidar model
and one NAIP model (Channel_Work/output_polygons/November2026/MA, see its README.md) split by marsh complex into gzipped flat
JSON that the browser draws itself. Polygons are simplified by SIMPLIFY_M metres (topology preserved) to drop the 0.5 m raster
staircase, reprojected to longitude / latitude and rounded to DECIMALS places.

  /home/williamcoast/anaconda3/envs/lidar_extract/bin/python scripts/build_channel_viewer_data.py
        [--out /mnt/fastdata/massmarsh_ingest/channels] [--simplify 0.36] [--layers lidar,naip] [--complexes 3,48]

Output (publish by copying the folder to /mnt/marsh01web/massmarsh_rs/channels/; the viewer reads <server>/channels/):
  index.json                 layers, labels, provenance, per-complex polygon counts and file sizes
  <layer>/<complex>.json.gz  {"layer", "complex", "n", "split_names", "id": [fid], "area_m2": [], "split": [index into split_names],
                              "polys": [ [ [outer x,y,x,y,...], [hole x,y,...], ...] per polygon part ] per polygon }
  readme.txt
The lidar_extract environment is used because gis_env's PROJ database does not open (reprojection would fail there).
"""
import argparse, datetime, gzip, json, os, resource, sys, time
import numpy as np, geopandas as gpd, pyogrio, shapely

SRC_DIR = '/home/williamcoast/Desktop/Projects/Channel_Work/output_polygons/November2026/MA'
LAYERS = {
    'lidar': dict(label='Lidar Extracted', file='MA_2021_lidar_model_A_w1_small_norim.gpkg', model='A_w1_small_norim',
                  description='Channels predicted from the 2021 USGS lidar (0.5 m) by the MassMarsh lidar channel model A_w1_small_norim '
                              '(U-Net, ResNet50 encoder; height above the local marsh level and relief at 2.5 and 10 m), thresholded at 0.5.'),
    'naip': dict(label='NAIP 2021', file='MA_2021_naip_model_A_w1_nrg_MA_CT06_norim.gpkg', model='A_w1_nrg_MA_CT06_norim',
                 description='Channels predicted from the 2021 Massachusetts NAIP imagery (0.6 m; near-infrared, red, green) by the MassMarsh imagery '
                             'channel model A_w1_nrg_MA_CT06_norim, trained on the polygons of the lidar model A_w1_small_norim over Massachusetts and Connecticut.'),
}
SPLITS = ['train', 'val', 'test', 'none']
README = """William Speiser, wspeiser@umass.edu
massmarsh_rs / channels (marsh01 web share, served at https://marsh01.ecs.umass.edu/share/massmarsh_rs/channels/)
{date}

Channel and ditch polygons for the Channel Viewer of the experimental portal page (massmarshviewer.com/experimental), built by
MassMarsh-Portal-Test/scripts/build_channel_viewer_data.py from Channel_Work/output_polygons/November2026/MA (see its README.md).
  index.json                 layers, labels, provenance, per-complex polygon counts and file sizes
  <layer>/<complex>.json.gz  gzipped flat JSON: ids, areas, model split and the polygon rings (longitude / latitude, {decimals} decimals)
                             of every channel polygon of one marsh complex, simplified by {simplify} m (topology preserved)
Layers: {layers}
The browser unpacks the .json.gz files itself (no Content-Encoding needed). Long-term share; please keep (mirror to marsh02).
"""


def rings_of(geoms):
    """Per polygon: list of parts, each a list of flat rings [x, y, x, y, ...] (outer first, holes after)."""
    parts, part_of = shapely.get_parts(geoms, return_index=True)
    rings, ring_of = shapely.get_rings(parts, return_index=True)
    coords, coord_of = shapely.get_coordinates(rings, return_index=True)
    ring_start = np.searchsorted(coord_of, np.arange(len(rings))); ring_end = np.append(ring_start[1:], len(coords))
    part_start = np.searchsorted(ring_of, np.arange(len(parts))); part_end = np.append(part_start[1:], len(rings))
    poly_start = np.searchsorted(part_of, np.arange(len(geoms))); poly_end = np.append(poly_start[1:], len(parts))
    out = []
    for i in range(len(geoms)):
        poly = []
        for p in range(poly_start[i], poly_end[i]):
            poly.append([coords[ring_start[r]:ring_end[r]].ravel().tolist() for r in range(part_start[p], part_end[p])])
        out.append(poly)
    return out


def build_layer(key, cfg, out, simplify_m, decimals, only):
    path = os.path.join(SRC_DIR, cfg['file']); t0 = time.time()
    df = pyogrio.read_dataframe(path, fid_as_index=True)
    print(f'{key}: {len(df)} polygons read in {time.time() - t0:.1f} s ({cfg["file"]})', flush=True)
    t = time.time(); geoms = shapely.simplify(df.geometry.values, simplify_m, preserve_topology=True)
    n0 = int(shapely.get_num_coordinates(df.geometry.values).sum()); n1 = int(shapely.get_num_coordinates(geoms).sum())
    print(f'{key}: simplified {simplify_m} m: {n0} -> {n1} vertices ({n1 / n0:.2f}) in {time.time() - t:.1f} s', flush=True)
    t = time.time(); ll = gpd.GeoSeries(geoms, crs=df.crs).to_crs(4326).values
    ll = shapely.set_precision(ll, 10 ** -decimals) if False else ll          # rounding is done on the coordinate arrays below
    print(f'{key}: reprojected in {time.time() - t:.1f} s', flush=True)
    complexes = df['complex'].to_numpy(); splits = df['split'].fillna('none').astype(str).to_numpy(); areas = np.round(df['area_m2'].to_numpy(), 1)
    fids = df.index.to_numpy()
    os.makedirs(os.path.join(out, key), exist_ok=True)
    info = {'label': cfg['label'], 'description': cfg['description'], 'model': cfg['model'], 'source': cfg['file'],
            'source_modified': datetime.datetime.fromtimestamp(os.path.getmtime(path)).strftime('%Y-%m-%d %H:%M'),
            'polygons': int(len(df)), 'area_ha': round(float(df['area_m2'].sum()) / 1e4, 1), 'vertices': n1,
            'split_counts': {s: int((splits == s).sum()) for s in SPLITS if (splits == s).any()},
            'built': datetime.datetime.now().strftime('%Y%m%dT%H%M'), 'complexes': {}}
    t = time.time(); total = 0
    for cx in sorted(set(int(c) for c in complexes)):
        if only and cx not in only: continue
        idx = np.flatnonzero(complexes == cx)
        sub = ll[idx]
        coords_rounded = rings_of(shapely.transform(sub, lambda a: np.round(a, decimals)))
        doc = {'layer': key, 'complex': cx, 'n': int(len(idx)), 'crs': 'EPSG:4326', 'simplify_m': simplify_m, 'decimals': decimals, 'split_names': SPLITS,
               'id': fids[idx].tolist(), 'area_m2': areas[idx].tolist(), 'split': [SPLITS.index(s) if s in SPLITS else 3 for s in splits[idx]], 'polys': coords_rounded}
        data = gzip.compress(json.dumps(doc, separators=(',', ':')).encode(), compresslevel=6)
        with open(os.path.join(out, key, f'{cx}.json.gz'), 'wb') as f: f.write(data)
        info['complexes'][str(cx)] = [int(len(idx)), len(data)]; total += len(data)
    print(f'{key}: {len(info["complexes"])} complex files, {total / 1e6:.1f} MB gzipped, written in {time.time() - t:.1f} s', flush=True)
    return info


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default='/mnt/fastdata/massmarsh_ingest/channels'); ap.add_argument('--simplify', type=float, default=0.36, help='metres, topology preserved')
    ap.add_argument('--decimals', type=int, default=6); ap.add_argument('--layers', default=','.join(LAYERS)); ap.add_argument('--complexes', default='', help='comma list to build a subset (testing)')
    a = ap.parse_args(); only = set(int(x) for x in a.complexes.split(',') if x)
    os.makedirs(a.out, exist_ok=True)
    index_path = os.path.join(a.out, 'index.json'); index = json.load(open(index_path)) if os.path.exists(index_path) else {}
    index.update({'built': datetime.datetime.now().strftime('%Y-%m-%d %H:%M'), 'simplify_m': a.simplify, 'decimals': a.decimals, 'crs': 'EPSG:4326', 'split_names': SPLITS,
                  'split_note': 'Most of the state is marsh the models trained on (train). Only val and test marshes show what a model does on ground it has not seen.',
                  'layers': index.get('layers', {})})
    for key in a.layers.split(','):
        if key not in LAYERS: sys.exit(f'unknown layer {key}; known: {", ".join(LAYERS)}')
        index['layers'][key] = build_layer(key, LAYERS[key], a.out, a.simplify, a.decimals, only)
        json.dump(index, open(index_path, 'w'), indent=1)
    with open(os.path.join(a.out, 'readme.txt'), 'w') as f:
        f.write(README.format(date=datetime.date.today().strftime('%d %b %Y'), decimals=a.decimals, simplify=a.simplify,
                              layers='; '.join(f'{k} = {v["label"]} ({v["model"]}, {v["polygons"]} polygons)' for k, v in index['layers'].items())))
    print(f'index -> {index_path}; peak memory {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6:.1f} GB')


if __name__ == '__main__':
    main()
