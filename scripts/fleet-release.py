#!/usr/bin/env python3
"""Publish or discover verified release manifests on the official GitHub release."""
import hashlib, importlib.util, io, json, re, subprocess, sys, tarfile, urllib.request
from pathlib import Path

REPO = 'golem-workers/sidewisp-plugin'
API = 'https://api.github.com/repos/' + REPO
spec = importlib.util.spec_from_file_location('controller', Path(__file__).with_name('fleet-controller.py'))
controller = importlib.util.module_from_spec(spec); spec.loader.exec_module(controller)

def download(url, limit=4_000_000):
    req = urllib.request.Request(url, headers={'User-Agent': 'Sidewisp-verified-fleet/1', 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(req, timeout=30) as response:
        data = response.read(limit + 1)
    if len(data) > limit: raise ValueError('RELEASE_TOO_LARGE')
    return data

def get_json(url): return json.loads(download(url))

def validate(manifest, metadata, fetch=download, get=get_json):
    version = manifest.get('version', '')
    if not re.fullmatch(r'\d+\.\d+\.\d+', version): raise ValueError('INVALID_VERSION')
    if metadata.get('draft') or metadata['tag_name'] != 'v'+version: raise ValueError('UNPUBLISHED_RELEASE')
    if manifest.get('schema') != 'sidewisp.verified-fleet.v1': raise ValueError('INVALID_SCHEMA')
    if not re.fullmatch('[a-f0-9]{40}', manifest.get('commit', '')): raise ValueError('INVALID_COMMIT')
    if not re.fullmatch('[a-f0-9]{64}', manifest.get('sha256', '')): raise ValueError('INVALID_HASH')
    if not manifest.get('environments') or not set(manifest['environments']) <= {'staging', 'production'}: raise ValueError('INVALID_ENVIRONMENT')
    cohorts = manifest.get('verifiedMigrations')
    if not isinstance(cohorts, list) or not cohorts or len(set(cohorts)) != len(cohorts): raise ValueError('MISSING_MIGRATIONS')
    evidence = manifest.get('migrationEvidence', [])
    for cohort in cohorts:
        if not isinstance(cohort, str) or not re.fullmatch(r'(openclaw|hermes)/[0-9A-Za-z.+-]+/[0-9A-Za-z.+-]+', cohort): raise ValueError('INVALID_COHORT')
        proof = next((x for x in evidence if x.get('cohort') == cohort), {})
        if proof.get('targetVersion') != version or proof.get('status') != 'completed' or proof.get('sourceUpdaterTested') is not True or proof.get('isolated') is not True:
            raise ValueError('UNVERIFIED_MIGRATION')
        if proof.get('artifactSha256') != manifest['sha256']: raise ValueError('EVIDENCE_ARTIFACT_MISMATCH')
        if manifest.get('deliveryMode') == 'host-idle-hot-reload-v1' and (not cohort.startswith('openclaw/') or type(proof.get('gatewayRestarts')) is not int or proof['gatewayRestarts'] != 0):
            raise ValueError('HOT_RELOAD_REQUIRES_ZERO_RESTARTS')
    obj = get(API+'/git/ref/tags/v'+version)['object']
    if obj['type'] == 'tag': obj = get(API+'/git/tags/'+obj['sha'])['object']
    if obj['type'] != 'commit' or obj['sha'] != manifest['commit']: raise ValueError('TAG_COMMIT_MISMATCH')
    name = 'sidewisp-plugin-'+version+'.tgz'
    asset = next((a for a in metadata['assets'] if a['name'] == name), None)
    expected = f'https://github.com/{REPO}/releases/download/v{version}/{name}'
    if not asset or asset['browser_download_url'] != expected: raise ValueError('MISSING_OFFICIAL_ARTIFACT')
    archive = fetch(expected)
    if hashlib.sha256(archive).hexdigest() != manifest['sha256']: raise ValueError('ARTIFACT_HASH_MISMATCH')
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
        member = tar.getmember('package/package.json')
        if not member.isfile() or member.size > 100_000: raise ValueError('INVALID_PACKAGE')
        package = json.load(tar.extractfile(member))
    if package.get('version') != version or package.get('name') != '@sidewisp/plugin': raise ValueError('PACKAGE_VERSION_MISMATCH')
    return manifest

def publish(path):
    path = Path(path); manifest = json.loads(path.read_text())
    metadata = get_json(API+'/releases/tags/v'+manifest['version'])
    validate(manifest, metadata)
    if any(a['name'] == 'fleet-rollout.json' for a in metadata['assets']):
        url = f'https://github.com/{REPO}/releases/download/v{manifest["version"]}/fleet-rollout.json'
        if get_json(url) != manifest: raise ValueError('MANIFEST_ALREADY_PUBLISHED_DIFFERENT')
        print('ALREADY_PUBLISHED'); return
    if path.name != 'fleet-rollout.json': raise ValueError('MANIFEST_FILENAME_REQUIRED')
    subprocess.run(['gh', 'release', 'upload', 'v'+manifest['version'], str(path), '--repo', REPO], check=True)
    print('PUBLISHED_VERIFIED_MANIFEST')

def sync(config_path):
    cfg = json.loads(Path(config_path).read_text())
    root = Path(cfg['releaseDir']); root.mkdir(mode=0o700, parents=True, exist_ok=True)
    releases = get_json(API+'/releases?per_page=30')
    for environment in ['staging', 'production']:
        candidates = []
        for r in releases:
            if r.get('draft') or not re.fullmatch(r'v\d+\.\d+\.\d+', r['tag_name']): continue
            if not any(a['name'] == 'fleet-rollout.json' for a in r['assets']): continue
            candidates.append(r)
        for r in sorted(candidates, key=lambda r: tuple(map(int,r['tag_name'][1:].split('.'))), reverse=True):
            path = root/(environment+'.json')
            old = json.loads(path.read_text()) if path.exists() else None
            if old and tuple(map(int,r['tag_name'][1:].split('.'))) < tuple(map(int,old['version'].split('.'))): break
            url = f'https://github.com/{REPO}/releases/download/{r["tag_name"]}/fleet-rollout.json'
            manifest = get_json(url)
            if environment not in manifest.get('environments', []): continue
            if old == manifest: break
            if old and old['version'] == manifest.get('version'): raise ValueError('IMMUTABLE_MANIFEST_CHANGED')
            validate(manifest, r)
            controller.atomic(path, json.dumps(manifest))
            print(json.dumps({'environment': environment, 'acceptedVersion': manifest['version']}))
            break

if __name__ == '__main__':
    try:
        if sys.argv[1] == 'publish': publish(sys.argv[2])
        elif sys.argv[1] == 'sync': sync(sys.argv[2])
        else: raise ValueError('INVALID_COMMAND')
    except Exception as e:
        code = str(e) if isinstance(e, ValueError) and re.fullmatch('[A-Z_]+', str(e)) else type(e).__name__
        print(json.dumps({'status': 'error', 'code': code}), file=sys.stderr); sys.exit(1)
