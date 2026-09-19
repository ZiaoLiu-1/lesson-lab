#!/usr/bin/env python3
"""Offline evidence checks; standard-library only, no model calls or credentials."""
import hashlib
import json
import math
import re
import statistics
from html import unescape
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / 'docs'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def require(condition, message):
    if not condition:
        raise SystemExit('FAIL: ' + message)


def close(a, b):
    return isinstance(a, (int, float)) and isinstance(b, (int, float)) and math.isclose(a, b, abs_tol=1e-9)


manifest = json.loads((DOCS / 'results/PROVENANCE.json').read_text())
data = json.loads((DOCS / 'results.json').read_text())
for entry in manifest['files']:
    require(sha((ROOT / entry['file']).read_bytes()) == entry['sha256'], 'File hash: ' + entry['file'])

raw_by_id = {}
for source in data['sources']:
    file = DOCS / source['packagePath']
    require(sha(file.read_bytes()) == source['sha256'], 'Raw source hash: ' + file.name)
    payload = json.loads(file.read_text())
    rows = payload if isinstance(payload, list) else payload['runs']
    require(len(rows) == source['records'], 'Source count: ' + file.name)
    for row in rows:
        require(row['runId'] not in raw_by_id, 'Duplicate source run ID')
        raw_by_id[row['runId']] = row

require(len(raw_by_id) == len(data['records']) == 77, '77 unique indexed source records')
indexed = {row['runId']: row for row in data['records']}
require(set(indexed) == set(raw_by_id), 'Index/source run ID equality')
for run_id, row in indexed.items():
    raw = raw_by_id[run_id]
    for key in ['taskId', 'phase', 'status', 'review', 'sourceHash', 'promptHash', 'schemaHash', 'browser']:
        require(row.get(key) == raw.get(key), 'Unchanged record field ' + key + ': ' + run_id)
    require(sha(raw['html'].encode()) == row['outputHashRecomputed'], 'Returned HTML hash: ' + run_id)
    canonical = json.dumps(raw, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    require(sha(canonical) == row['canonicalRecordSha256'], 'Canonical record hash: ' + run_id)

checked_groups = 0
for cohort_name, cohort in data['cohorts'].items():
    records = [r for r in data['records'] if r['cohort'] == cohort_name]
    require(len(records) == cohort['recordCount'], 'Cohort count: ' + cohort_name)
    require(set(cohort['recordIds']) == {r['runId'] for r in records}, 'Cohort IDs: ' + cohort_name)
    for group in cohort['perTask'] + cohort['basket']:
        points = group['points']
        require(set(group['runIds']) == {p['runId'] for p in points}, 'Group/point run ID equality')
        for point in points:
            row = indexed[point['runId']]
            require(row['cohort'] == cohort_name and row['eligibleHistoricalReviewedTiming'], 'Group membership')
            require(close(point['visibleSeconds'], row['browser']['renderedMs'] / 1000), 'Point visible time')
            require(close(point['codeSeconds'], row['browser']['codeReceivedMs'] / 1000), 'Point code time')
        for series, field in [('visibleSeconds', 'visibleSeconds'), ('codeSeconds', 'codeSeconds')]:
            values = [p[field] for p in points]
            require(len(values) == group[series]['n'], 'Group sample count')
            for key, value in [('median', statistics.median(values)), ('min', min(values)), ('max', max(values))]:
                require(close(group[series][key], value), 'Aggregate ' + series + '.' + key)
        checked_groups += 1

html = (DOCS / 'results.html').read_text()
points = re.findall(r'<circle class="pt"[^>]*data-run-id="([^"]+)"[^>]*>\s*<title>(.*?)</title>', html)
require(len(points) == 63, '63 plotted observations')
require(len({p[0] for p in points}) == 63, '63 unique plotted IDs')
for run_id, title in points:
    match = re.fullmatch(r'(T[123]): ([0-9.]+) s · (.+)', unescape(title))
    require(match is not None, 'Inspectable point tooltip')
    require(match[1] == indexed[run_id]['taskId'] and match[3] == run_id, 'Point identity')
    seconds = indexed[run_id]['browser']['renderedMs'] / 1000
    require(abs(float(match[2]) - seconds) <= 0.000050001, 'Point tooltip time: ' + run_id)

for href in re.findall(r'href="([^"]+)"', html):
    if href.startswith(('#', 'http:', 'https:')):
        continue
    require((DOCS / href.split('#')[0]).is_file(), 'Viewer link: ' + href)

private = re.compile(rb'(?:/Users/|/home/|/private/var/|/var/folders/|/tmp/)|(?:sk-proj-|csk-)[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9_-]{12,}')
for entry in manifest['files']:
    require(not private.search((ROOT / entry['file']).read_bytes()), 'Private path/key pattern: ' + entry['file'])

print(json.dumps({'pass': True, 'sourceFiles': 8, 'indexedRecords': 77, 'historicalMeasured': 69,
                  'rehearsals': 8, 'pendingReviews': 4, 'aggregateGroupsChecked': checked_groups,
                  'scatterPointsChecked': len(points), 'modelCalls': 0}, indent=2))
