"""Microbenchmark actual local process overhead; never a whole-paper/model benchmark."""
import argparse
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', required=True)
parser.add_argument('--repeats', type=int, default=3)
args = parser.parse_args()
if not 1 <= args.repeats <= 5:
    parser.error('repeats must be 1..5')
worker = Path(__file__).resolve().parents[2] / 'python/chemistry_worker.py'
structures = ['CCO', 'CC=O', 'CC(=O)O', 'C[C@H](O)[C@H](N)C(=O)OC']
def invoke(request):
    result = subprocess.run([sys.executable, '-B', '-X', 'utf8', str(worker)], input=json.dumps(request), capture_output=True, encoding='utf-8', timeout=30)
    if result.returncode:
        raise RuntimeError(result.stderr)
    envelope = json.loads(result.stdout)
    if envelope.get('ok') is not True:
        raise RuntimeError(envelope.get('error'))
    return envelope['result']
sequential, batch = [], []
for repeat in range(args.repeats):
    # Alternate order, verify equal native chemistry rather than timing unchecked output.
    timings, results = {}, {}
    for mode in (['sequential', 'batch'] if repeat % 2 == 0 else ['batch', 'sequential']):
        start = time.perf_counter()
        results[mode] = [invoke({'op':'inspect','smiles': s}) for s in structures] if mode == 'sequential' else invoke({'op':'inspect_structures','smiles':structures})['structures']
        timings[mode] = time.perf_counter() - start
    assert [(r['smiles'], r['formula'], round(r['mw'], 6)) for r in results['sequential']] == [(r['smiles'], r['formula'], round(r['mw'], 6)) for r in results['batch']]
    sequential.append(timings['sequential']); batch.append(timings['batch'])
report = {'scope':'four native structures; process startup and parsing only', 'notWholePaperBenchmark':True, 'python':platform.python_version(), 'platform':platform.platform(), 'samples':args.repeats, 'structures':len(structures), 'sequentialProcessesPerSample':len(structures), 'batchProcessesPerSample':1, 'sequentialSeconds':sequential, 'batchSeconds':batch, 'medianSpeedup':statistics.median(sequential)/statistics.median(batch), 'sequentialMedianSeconds':statistics.median(sequential), 'batchMedianSeconds':statistics.median(batch)}
Path(args.output).write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
print(json.dumps(report))
