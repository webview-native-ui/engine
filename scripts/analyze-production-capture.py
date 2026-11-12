#!/usr/bin/env python3
"""Summarize observed contact stages, never the requested timing label."""
import argparse
import json
import math
import statistics
from pathlib import Path

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('input', type=Path)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
rows = json.loads(a.input.read_text())
trials = [row for row in rows if 'mode' in row]
assert len(trials) == 36 and len({(row['mode'], row['index']) for row in trials}) == 36
assert all(row.get('token') for row in trials)
assert all(len([e for e in row['events'] if e.get('capturePolicy')]) == 2 for row in trials), 'Unexpected prepare request'
assert all(len([t for t in row['timings'] if 'requestToReadyMs' in t]) == 1 for row in trials), 'Unexpected recapture'
def summary(values):
    if not values:
        return None
    ordered = sorted(values)
    at = (len(ordered) - 1) * .9
    lo, hi = math.floor(at), math.ceil(at)
    return {'n': len(values), 'p50': statistics.median(values), 'p90': ordered[lo] + (ordered[hi] - ordered[lo]) * (at - lo)}
result = {'trials': len(trials), 'warmupPerRequestedMode': 2, 'stages': {}, 'idle': {}}
for stage in ['ready', 'waiting', 'processing']:
    selected = [row for row in trials if row['index'] >= 2 and any(t.get('stage') == stage and 'mainThreadMs' in t for t in row['timings'])]
    result['stages'][stage] = {'n': len(selected)}
    for field in ['mainThreadMs', 'contactToReadyMs', 'acquisitionToReadyMs', 'requestToReadyMs', 'decodeAndInstallMs']:
        result['stages'][stage][field] = summary([t[field] for row in selected for t in row['timings'] if field in t])
for field in ['waitMs', 'acquisitionMs', 'processingMs']:
    result['idle'][field] = summary([t['native'][field] for row in trials if row['index'] >= 2 and row['mode'] == 'ready' for t in row['timings'] if t.get('native')])
result['idle']['waitAndAcquisitionMs'] = summary([t['native']['waitMs'] + t['native']['acquisitionMs'] for row in trials if row['index'] >= 2 and row['mode'] == 'ready' for t in row['timings'] if t.get('native')])
manual = [row for row in rows if 'manualResult' in row]
assert manual and manual[-1]['matchesReference'] is True and len(manual[-1]['manualResult']['parts']) == 2
result['manual'] = {'matchesIdlePNGBytes': True, 'timing': manual[-1]['manualResult']['timing'], 'events': [row['manualEvent'] for row in rows if 'manualEvent' in row], 'actionDelivered': any(row.get('manualAction') for row in rows)}
assert result['manual']['actionDelivered']
a.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
