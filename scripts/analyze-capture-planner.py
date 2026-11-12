#!/usr/bin/env python3
"""Fit the calibration matrix and compare frozen planner decisions with holdout timings."""
import argparse
import collections
import json
import math
import statistics
from pathlib import Path

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('matrix', type=Path)
p.add_argument('verification', type=Path)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
def quantile(values, fraction):
    values = sorted(values)
    position = (len(values) - 1) * fraction
    low, high = math.floor(position), math.ceil(position)
    return values[low] + (values[high] - values[low]) * (position - low)
def aggregate(rows):
    groups = collections.defaultdict(list)
    for row in rows:
        if 'scenario' in row and row['trial'] >= 2:
            groups[row['scenario'], row['scale'], row['plan']].append(row)
    result = []
    for rows in groups.values():
        assert len(rows) == 10
        values = [row['acquisitionMs'] for row in rows]
        result.append(dict(rows[0], p50=statistics.median(values), p90=quantile(values, .9)))
    return result

def solve(matrix, target):
    work = [list(row) + [value] for row, value in zip(matrix, target)]
    for k in range(len(target)):
        pivot = max(range(k, len(target)), key=lambda i: abs(work[i][k]))
        work[k], work[pivot] = work[pivot], work[k]
        if abs(work[k][k]) < 1e-10:
            return None
        divisor = work[k][k]
        work[k] = [value / divisor for value in work[k]]
        for i in range(len(target)):
            if i != k:
                divisor = work[i][k]
                work[i] = [x - divisor * y for x, y in zip(work[i], work[k])]
    return [row[-1] for row in work]

matrix = json.loads(a.matrix.read_text())
verification = json.loads(a.verification.read_text())
assert matrix[-1].get('done') and verification[-1].get('done')
assert all(row['groups'] == [[0, 0, 466, 678]] for row in matrix + verification if row.get('fullWindow')), 'This fit targets the recorded 466x678, scale-3 display'
calibration = [row for row in aggregate(matrix) if not row['viewMode']]
counts = collections.Counter((row['scenario'], row['scale']) for row in calibration)
def features(row):
    return [row['passes'], sum(rect[3] * 466 * 9 / 1e6 for rect in row['groups']), row['megapixels']]
best = None
for mask in range(1, 8):
    indices = [i for i in range(3) if mask & (1 << i)]
    lhs = [[0.] * len(indices) for _ in indices]
    rhs = [0.] * len(indices)
    for row in calibration:
        weight = 1 / counts[row['scenario'], row['scale']]
        values = features(row)
        for i, ii in enumerate(indices):
            rhs[i] += weight * values[ii] * row['p50']
            for j, jj in enumerate(indices):
                lhs[i][j] += weight * values[ii] * values[jj]
    solution = solve(lhs, rhs)
    if solution is None or min(solution) < 0:
        continue
    coefficients = [0.] * 3
    for index, value in zip(indices, solution):
        coefficients[index] = value
    error = sum((sum(c * f for c, f in zip(coefficients, features(row))) - row['p50']) ** 2 / counts[row['scenario'], row['scale']] for row in calibration)
    if best is None or error < best[0]:
        best = error, coefficients
assert best is not None
summaries = []
measured = aggregate(verification)
for key in sorted({(row['scenario'], row['scale']) for row in measured}):
    candidates = [row for row in measured if (row['scenario'], row['scale']) == key]
    selected = [row for row in candidates if row['selected']]
    assert len(selected) == 1
    selected = selected[0]
    oracle = min(candidates, key=lambda row: row['p50'])
    union = next(row for row in candidates if row['plan'] == 0)
    summaries.append({'scenario': key[0], 'scale': key[1], 'passes': selected['passes'], 'selectedP50': selected['p50'], 'selectedP90': selected['p90'],
                      'unionP50': union['p50'], 'oracleP50': oracle['p50'], 'regretMs': selected['p50'] - oracle['p50']})
window_checks = [row for row in matrix + verification if not row.get('viewMode', True) and 'pixelsMatchUnion' in row]
assert all(row['pixelsMatchUnion'] for row in window_checks)
assert all(row['pixelsMatchUnion'] for row in verification if row.get('selected') and 'pixelsMatchUnion' in row)
result = {'calibrationSamples': len(matrix) - 1, 'verificationSamples': len(verification) - 1, 'warmupPerPlan': 2,
          'windowFit': dict(zip(['drawMilliseconds', 'rowMegapixelMilliseconds', 'megapixelMilliseconds'], best[1])),
          'productionWindowCoefficients': {'drawMilliseconds': 7, 'rowMegapixelMilliseconds': 5, 'megapixelMilliseconds': 2.5},
          'fullWidthBreakEvenSavedMegapixels': 7 / 7.5, 'verifiedWindowPixelComparisons': len(window_checks), 'holdout': summaries,
          'viewNonrepeatability': [{'scenario': row['scenario'], 'plan': row['plan'], 'repeatUnionMatchesInitial': row.get('repeatUnionMatchesInitial')}
                                   for row in verification if row.get('pixelsMatchUnion') is False]}
a.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
