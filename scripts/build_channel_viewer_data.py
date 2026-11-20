#!/usr/bin/env python3
"""Channel Viewer data (experimental portal page, massmarsh/tool-channel.js): the statewide channel polygons of one lidar model,
one NAIP model and the lidar polygons cut into ditch and tidal-channel parts (Channel_Work/output_polygons/November2026/MA, see
its README.md and Channel_and_Ditches/README.md) split by marsh complex into gzipped flat JSON that the browser draws itself.
Polygons are simplified by SIMPLIFY_M metres (topology preserved) to drop the 0.5 m raster staircase, reprojected to
longitude / latitude and rounded to DECIMALS places.

  /home/williamcoast/anaconda3/envs/lidar_extract/bin/python scripts/build_channel_viewer_data.py
        [--out /mnt/fastdata/massmarsh_ingest/channels] [--simplify 0.36] [--layers lidar,naip,ditch] [--complexes 3,48]

Output (publish by copying the folder to /mnt/marsh01web/massmarsh_rs/channels/; the viewer reads <server>/channels/):
  index.json                 layers, labels, provenance, per-complex polygon counts and file sizes
  <layer>/<complex>.json.gz  {"layer", "complex", "n", "split_names", "id": [fid], "area_m2": [], "split": [index into split_names],
                              "polys": [ [ [outer x,y,x,y,...], [hole x,y,...], ...] per polygon part ] per polygon,
                              and for a classed layer "class_names", "cls": [index into class_names], "prob": [ditch probability or null],
                              "prob_lo", "prob_hi" (range over the stretches), "cl_m" (centerline metres), "n_str" (stretches)}
  readme.txt
The ditch layer's probability: the classifier scores centerline stretches (layer centerlines, column prob), not polygons, so a
polygon part gets the length-weighted mean of the stretches whose midpoints lie inside it (a midpoint on the outline goes to the
nearest part within 1 m). Parts without a stretch (channel throughout by the width rule, or too small to thin) get null.
The lidar_extract environment is used because gis_env's PROJ database does not open (reprojection would fail there).
"""
import argparse, datetime, gzip, json, os, resource, sys, time
import numpy as np, geopandas as gpd, pyogrio, shapely

SRC_DIR = '/home/williamcoast/Desktop/Projects/Channel_Work/output_polygons/November2026/MA'
DITCH_DESCRIPTION = ('The Lidar Extracted polygons cut into ditch parts and tidal-channel parts (Channel_Work/code/classify_ditch_channel.py, 19 Nov 2026): '
                     'parts wider than 5 m are channel; the rest is thinned to centerline stretches that are classed first by rules (a digitized ditch line within '
                     '5 m and parallel within 10 degrees, plus shape, grid, cross, branch, in-line and surroundings rules) and then by a gradient-boosting classifier '
                     'fitted on 696 stretches judged by eye on 2025 imagery (held-out F1 0.92, recall 0.94, precision 0.91). The ditch probability is the '
                     'classifier\'s probability that a stretch is a ditch (classed ditch at 0.5 or more); a polygon part shows the length-weighted mean of its stretches.')
LAYERS = {
    'lidar': dict(label='Lidar Extracted', file='MA_2021_lidar_model_A_w1_small_norim.gpkg', model='A_w1_small_norim',
                  description='Channels predicted from the 2021 USGS lidar (0.5 m) by the MassMarsh lidar channel model A_w1_small_norim '
                              '(U-Net, ResNet50 encoder; height above the local marsh level and relief at 2.5 and 10 m), thresholded at 0.5.'),
    'naip': dict(label='NAIP 2021', file='MA_2021_naip_model_A_w1_nrg_MA_CT06_norim.gpkg', model='A_w1_nrg_MA_CT06_norim',
                 description='Channels predicted from the 2021 Massachusetts NAIP imagery (0.6 m; near-infrared, red, green) by the MassMarsh imagery '
                             'channel model A_w1_nrg_MA_CT06_norim, trained on the polygons of the lidar model A_w1_small_norim over Massachusetts and Connecticut.'),
    'ditch': dict(label='Lidar (Ditch Delineated)', file='Channel_and_Ditches/MA_2021_ditch_vs_channel_A_w1_small_norim_lines_and_shape.gpkg',
                  gpkg_layer='polygon_parts', model='A_w1_small_norim + ditch_channel_model', description=DITCH_DESCRIPTION,
                  classes=dict(field='class', names=['channel', 'ditch']),
                  prob=dict(gpkg_layer='centerlines', field='prob', weight='length_m', near_m=1.0)),
}
SPLITS = ['train', 'val', 'test', 'none']
README = """William Speiser, wspeiser@umass.edu
massmarsh_rs / channels (marsh01 web share, served at https://marsh01.ecs.umass.edu/share/massmarsh_rs/channels/)
{date}

Channel and ditch polygons for the Channel Viewer of the experimental portal page (massmarshviewer.com/experimental), built by
MassMarsh-Portal-Test/scripts/build_channel_viewer_data.py from Channel_Work/output_polygons/November2026/MA (see its README.md).
  index.json                 layers, labels, provenance, per-complex polygon counts and file sizes
  <layer>/<complex>.json.gz  gzipped flat JSON: ids, areas, model split and the polygon rings (longitude / latitude, {decimals} decimals)
                             of every channel polygon of one marsh complex, simplified by {simplify} m (topology preserved);
                             the ditch layer adds the class (channel / ditch) and the ditch probability of every polygon part
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


def attach_prob(df, path, pc):
    """Per polygon part: length-weighted mean, range, metres and count of the centerline stretches (layer pc['gpkg_layer'], column
    pc['field']) whose midpoints lie inside it; a midpoint on the outline goes to the nearest part within pc['near_m']."""
    t = time.time()
    lines = pyogrio.read_dataframe(path, layer=pc['gpkg_layer'], columns=[pc['field'], pc['weight']])
    mids = shapely.line_interpolate_point(lines.geometry.values, 0.5, normalized=True)
    tree = shapely.STRtree(df.geometry.values)
    li, pi = tree.query(mids, predicate='within')
    matched = np.zeros(len(mids), bool); matched[li] = True
    um = np.flatnonzero(~matched); n_near = 0
    if len(um):
        li2, pi2 = tree.query_nearest(mids[um], max_distance=pc['near_m'], return_distance=False, all_matches=False)
        li = np.concatenate([li, um[li2]]); pi = np.concatenate([pi, pi2]); n_near = len(li2)
    p = lines[pc['field']].to_numpy(float)[li]; w = np.maximum(lines[pc['weight']].to_numpy(float)[li], 0.1)
    ok = np.isfinite(p); li, pi, p, w = li[ok], pi[ok], p[ok], w[ok]
    n = len(df)
    wsum = np.bincount(pi, weights=w, minlength=n); pw = np.bincount(pi, weights=p * w, minlength=n); cnt = np.bincount(pi, minlength=n)
    lo = np.full(n, np.inf); hi = np.full(n, -np.inf); np.minimum.at(lo, pi, p); np.maximum.at(hi, pi, p)
    mean = np.where(cnt > 0, pw / np.maximum(wsum, 1e-9), np.nan); lo[cnt == 0] = np.nan; hi[cnt == 0] = np.nan
    print(f'prob: {len(lines)} stretches, {len(li)} matched to parts ({n_near} by nearest part, {len(lines) - len(li)} unmatched); '
          f'{int((cnt > 0).sum())} of {n} parts scored in {time.time() - t:.1f} s', flush=True)
    return mean, lo, hi, wsum, cnt


def build_layer(key, cfg, out, simplify_m, decimals, only):
    path = os.path.join(SRC_DIR, cfg['file']); t0 = time.time()
    df = pyogrio.read_dataframe(path, layer=cfg.get('gpkg_layer'), fid_as_index=True)
    print(f'{key}: {len(df)} polygons read in {time.time() - t0:.1f} s ({cfg["file"]}' + (f', layer {cfg["gpkg_layer"]}' if cfg.get('gpkg_layer') else '') + ')', flush=True)
    cls = prob = None
    if cfg.get('classes'):
        names = cfg['classes']['names']; cls = np.array([names.index(c) if c in names else -1 for c in df[cfg['classes']['field']].astype(str)])
        if (cls < 0).any(): sys.exit(f'{key}: {int((cls < 0).sum())} polygons with a class outside {names}')
    if cfg.get('prob'):
        prob = attach_prob(df, path, cfg['prob'])
        for ci, cname in enumerate(names if cls is not None else []):
            sel = cls == ci; un = sel & (prob[4] == 0)
            print(f'{key}: {cname}: {int(sel.sum())} parts, {int(un.sum())} without a stretch (unscored; area {df["area_m2"].to_numpy()[un].sum() / 1e4:.1f} ha, '
                  f'median {np.median(df["area_m2"].to_numpy()[un]) if un.any() else 0:.1f} m2); scored parts mean prob {np.nanmean(prob[0][sel & (prob[4] > 0)]) if (sel & (prob[4] > 0)).any() else float("nan"):.2f}', flush=True)
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
    if cfg.get('gpkg_layer'): info['source_layer'] = cfg['gpkg_layer']
    if cls is not None:
        info['classes'] = {'field': cfg['classes']['field'], 'names': names, 'counts': {c: int((cls == i).sum()) for i, c in enumerate(names)},
                           'area_ha': {c: round(float(df['area_m2'].to_numpy()[cls == i].sum()) / 1e4, 1) for i, c in enumerate(names)}}
    if prob is not None:
        info['prob'] = {'source': f"{cfg['prob']['gpkg_layer']}.{cfg['prob']['field']}", 'scored': int((prob[4] > 0).sum()), 'unscored': int((prob[4] == 0).sum()),
                        'note': 'Length-weighted mean of the ditch probability of the centerline stretches whose midpoints lie in the polygon part; '
                                'null where the part has no stretch (channel throughout by the width rule, wider than 5 m, or too small to thin to a centerline).'}
    t = time.time(); total = 0
    for cx in sorted(set(int(c) for c in complexes)):
        if only and cx not in only: continue
        idx = np.flatnonzero(complexes == cx)
        sub = ll[idx]
        coords_rounded = rings_of(shapely.transform(sub, lambda a: np.round(a, decimals)))
        doc = {'layer': key, 'complex': cx, 'n': int(len(idx)), 'crs': 'EPSG:4326', 'simplify_m': simplify_m, 'decimals': decimals, 'split_names': SPLITS,
               'id': fids[idx].tolist(), 'area_m2': areas[idx].tolist(), 'split': [SPLITS.index(s) if s in SPLITS else 3 for s in splits[idx]], 'polys': coords_rounded}
        if cls is not None: doc['class_names'] = names; doc['cls'] = cls[idx].tolist()
        if prob is not None:
            r2 = lambda arr: [None if not np.isfinite(v) else round(float(v), 2) for v in arr[idx]]
            doc['prob'] = r2(prob[0]); doc['prob_lo'] = r2(prob[1]); doc['prob_hi'] = r2(prob[2])
            doc['cl_m'] = [round(float(v), 1) for v in prob[3][idx]]; doc['n_str'] = prob[4][idx].tolist()
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
