#!/usr/bin/env python3
"""Serialized persistent controller; only an explicit root-owned config can enable apply."""
import fcntl, json, os, re, shlex, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent

def atomic(path, data, mode=0o600, owner=None):
    path = Path(path)
    fd, tmp = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        os.fchmod(fd, mode)
        if owner is not None: os.fchown(fd, *owner)
        with os.fdopen(fd, 'w') as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def env_read(paths):
    env = {}
    for path in paths:
        for line in Path(path).read_text().splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                k, v = line.split('=', 1)
                env[k] = ' '.join(shlex.split(v))
    return env

def render_policy(text, policy):
    ids = policy['allowlist']
    if not all(re.fullmatch(r'sw_ins_[A-Za-z0-9-]+', i) for i in ids): raise ValueError('INVALID_IDS')
    values = {'SIDEWISP_PLUGIN_STABLE_VERSION': policy['version'], 'SIDEWISP_PLUGIN_STABLE_SPEC': policy['spec'],
      'SIDEWISP_PLUGIN_STABLE_SHA256': policy['sha256'], 'SIDEWISP_UPDATE_ROLLOUT_PERCENT': '0',
      'SIDEWISP_UPDATE_CANARY_INSTALLATIONS': ','.join(sorted(ids)), 'SIDEWISP_UPDATE_RESTART_DELAY_SECONDS': '60'}
    old = env_text(text)
    if all(old.get(k, '') == v for k, v in values.items()): return text
    # No recipients before a production canary appears: do not restart idle APIs
    # merely to change a target that nobody can receive.
    if not ids and not old.get('SIDEWISP_UPDATE_CANARY_INSTALLATIONS', '').strip() and old.get('SIDEWISP_UPDATE_ROLLOUT_PERCENT', '0') == '0': return text
    return '\n'.join(l for l in text.splitlines() if l.split('=', 1)[0] not in values) + '\n' + ''.join(k+'='+v+'\n' for k,v in values.items())

def env_text(text):
    return {l.split('=',1)[0]: ' '.join(shlex.split(l.split('=',1)[1])) for l in text.splitlines() if '=' in l and not l.lstrip().startswith('#')}

def restart(unit):
    subprocess.run(['systemctl', 'restart', unit], check=True, capture_output=True, timeout=90)

def ready(url):
    for _ in range(12):
        try:
            with urllib.request.urlopen(url, timeout=3) as r:
                if r.status == 200: return True
        except Exception: pass
        time.sleep(1)
    return False

def apply_policy(targets, policy, backup_dir, restart_fn=restart, ready_fn=ready):
    changed = []
    try:
        for target in targets:
            p = Path(target['envFile'])
            if p.is_symlink() or not p.is_file(): raise ValueError('INVALID_ENV_FILE')
            old = p.read_text(); new = render_policy(old, policy)
            if old == new: continue
            st = p.stat()
            backup = Path(backup_dir) / (p.name + '.before')
            if not backup.exists(): atomic(backup, old)
            changed.append((target, old, st))
            atomic(p, new, st.st_mode & 0o777, (st.st_uid, st.st_gid))
            restart_fn(target['unit'])
            if not ready_fn(target['readyUrl']): raise RuntimeError('READINESS_FAILED')
    except Exception:
        rollback_ok = True
        for target, old, st in reversed(changed):
            try:
                atomic(target['envFile'], old, st.st_mode & 0o777, (st.st_uid, st.st_gid))
                restart_fn(target['unit'])
                if not ready_fn(target['readyUrl']): rollback_ok = False
            except Exception: rollback_ok = False
        raise RuntimeError('APPLY_FAILED_ROLLED_BACK' if rollback_ok else 'APPLY_AND_ROLLBACK_FAILED') from None
    return len(changed)

def main(config_path, dry_run=False):
    config = json.loads(Path(config_path).read_text())
    root = Path(config['stateDir']); root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root/'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (root/'APPLY_BLOCKED').exists(): raise RuntimeError('APPLY_BLOCKED_REVIEW_REQUIRED')
        release = json.loads(Path(config['releaseFile']).read_text())
        if config['environment'] not in release['environments']: return
        state_path = root / (release['version']+'.json')
        state = json.loads(state_path.read_text()) if state_path.exists() else None
        # Never abandon an unfinished previous rollout silently.
        for other in root.glob('[0-9]*.json'):
            if other == state_path: continue
            previous = json.loads(other.read_text())
            if previous.get('halted') or any(not a['completed'] for a in previous['attempts'].values()):
                raise RuntimeError('PREVIOUS_RELEASE_UNRESOLVED')
        env = dict(os.environ); env.update(env_read(config['envFiles']))
        r = subprocess.run(['node', str(HERE/'fleet-inventory.mjs'), config['pgModule']], env=env,
          capture_output=True, text=True, check=True, timeout=40)
        agents = json.loads(r.stdout)
        for a in agents: a['quarantined'] = a['id'] in config.get('quarantined', [])
        data = {'release': release, 'environment': config['environment'], 'agents': agents, 'state': state}
        with tempfile.NamedTemporaryFile(mode='w', dir=root, suffix='.json') as inp:
            json.dump(data, inp); inp.flush()
            r = subprocess.run(['node', str(HERE/'plan-fleet-rollout.mjs'), inp.name], capture_output=True, text=True, check=True, timeout=15)
        plan = json.loads(r.stdout)
        summary = {'at': int(time.time()*1000), 'environment': config['environment'], 'version': release['version'],
          'phase': plan['nextState']['phase'], 'halted': plan['nextState']['halted'], 'observations': plan['observations'],
          'recipients': plan['policy']['allowlist'], 'dryRun': dry_run}
        if not dry_run:
            if config.get('apply') is not True: raise RuntimeError('APPLY_NOT_ENABLED')
            atomic(state_path, json.dumps(plan['nextState']))
            backups = root/'backups'/str(time.time_ns()); backups.mkdir(parents=True, mode=0o700)
            try: summary['servicesChanged'] = apply_policy(config['targets'], plan['policy'], backups)
            except Exception as e:
                atomic(root/'APPLY_BLOCKED', str(e)); raise
            if not any(backups.iterdir()): backups.rmdir()
            atomic(root/'status.json', json.dumps(summary))
        print(json.dumps(summary))

if __name__ == '__main__':
    try: main(sys.argv[1], '--dry-run' in sys.argv[2:])
    except Exception as e:
        # Never log DSNs, subprocess output, environment assignments or raw exceptions.
        code = str(e) if isinstance(e, (RuntimeError, ValueError)) and re.fullmatch('[A-Z_]+', str(e)) else type(e).__name__
        print(json.dumps({'status': 'error', 'code': code}), file=sys.stderr); sys.exit(1)
