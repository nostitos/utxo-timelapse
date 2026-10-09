#!/usr/bin/env python3
"""Optional node-side daily updater; cron installation is explicit and root-only.

Default prints a daily 03:15 (node local time) cron line for operator review.
--install-root-cron installs /etc/cron.d/utxo-blk-update once (identical is a no-op;
differing existing content is refused). Parent supplies privilege externally; no
sudo/password handling or group changes. Use a root-owned script in a root-owned
non-writable directory, e.g. /usr/local/lib/utxo-timelapse/.
Install only after reviewing the actual retained container/config and ensuring
ALL other updater entrypoints share --lock. --run checks the retained v3 runtime
and its bind-mounted config before docker start --attach buv_blk_v3. It never
creates/recreates containers, truncates data, repairs failures, or restarts a
failed updater. Existing running jobs are left alone. No hash append attestation
is manufactured: truncate=false alone does not prove historical immutability.
Cron must have docker permissions and a trusted PATH; logs use cron mail.
"""
import argparse
import fcntl
import json
import os
import tempfile
from pathlib import Path, PurePosixPath
import shlex
import subprocess
import sys

CONTAINER = 'buv_blk_v3'


def inspect_container():
    return json.loads(subprocess.check_output(['docker', 'inspect', CONTAINER], text=True))[0]


def check_config(info, config):
    if info['Config']['Image'] != 'buv:checkpoint-v3':
        raise ValueError('unexpected image; manual review required')
    if info['HostConfig'].get('RestartPolicy', {}).get('Name', 'no') not in ('', 'no'):
        raise ValueError('automatic restart policy is not allowed')
    args = [info['Path']] + info.get('Args', [])
    if PurePosixPath(args[0]).name != 'buv' or '-tc=utxo_to_change' not in args:
        raise ValueError('unexpected command; direct buv utxo_to_change required')
    if any(a not in ('-ns', '-tc=utxo_to_change') and not a.startswith('-cfg=') for a in args[1:]):
        raise ValueError('unexpected updater arguments; manual review required')
    cfg_args = [a[5:] for a in args if a.startswith('-cfg=')]
    if len(cfg_args) != 1 or not cfg_args[0].startswith('/'):
        raise ValueError('one absolute -cfg= path required')
    target = PurePosixPath(cfg_args[0])
    # Most-specific mount wins, as in the container namespace.
    mounts = sorted(info['Mounts'], key=lambda m: len(m['Destination']), reverse=True)
    actual = None
    for m in mounts:
        try:
            rel = target.relative_to(m['Destination'])
        except ValueError:
            continue
        if m['Type'] != 'bind':
            raise ValueError('config must be a verifiable host bind mount')
        actual = Path(m['Source']).joinpath(*rel.parts).resolve()
        break
    if actual != config.resolve():
        raise ValueError('config does not match container mount')
    cfg = json.loads(config.read_text())
    if cfg.get('allowBlkFileTruncate') is not False:
        raise ValueError('allowBlkFileTruncate must be explicitly false')
    if cfg.get('blkFile') != '/buv_data/changes.blk1.v3' or cfg.get('checkpointFile') != '/buv_data/checkpoint_v3.utxo':
        raise ValueError('unexpected v3 data paths')
    return cfg


def run(config, lock):
    with lock.open('a') as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('idle check: another helper holds the lock; skipped')
            return 0
        info = inspect_container()
        state = info['State']
        if state.get('Running') or state.get('Restarting') or state.get('Paused'):
            print('idle check: container active; skipped')
            return 0
        if state.get('Status') != 'exited' or state.get('ExitCode') != 0 or state.get('OOMKilled') or state.get('Error'):
            raise ValueError('container not cleanly exited; manual review required')
        check_config(info, config)
        subprocess.run(['docker', 'start', '--attach', CONTAINER], check=True)
        final = inspect_container()['State']
        if final.get('Status') != 'exited' or final.get('ExitCode') != 0 or final.get('OOMKilled') or final.get('Error'):
            raise ValueError('updater failed or still active; manual review required')
        print('v3 updater exited successfully; BLK/checkpoint validation remains required')
    return 0



def trusted_root_script(script):
    for path in (script, *script.parents):
        st = path.stat()
        if st.st_uid != 0 or st.st_mode & 0o022:
            raise ValueError('root cron script and ancestors must be root-owned and not group/world writable')


def cron_line(script, config, lock, root=False):
    parts = ['/usr/bin/python3', str(script), '--run', '--config', str(config), '--lock', str(lock)]
    if any('\n' in p or '\r' in p for p in parts):
        raise ValueError('newline in cron path')
    return '15 3 * * * ' + ('root ' if root else '') + shlex.join(parts).replace('%', '\\%')


def install_root_cron(config, lock, destination=Path('/etc/cron.d/utxo-blk-update')):
    if os.geteuid() != 0:
        raise ValueError('root required; parent must arrange privilege outside this script')
    script = Path(__file__).resolve()
    trusted_root_script(script)
    content = ('# UTXO Timelapse daily BLK update; managed, no credentials.\n'
               'SHELL=/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n'
               + cron_line(script, config, lock, root=True) + '\n')
    if destination.is_symlink():
        raise ValueError('refusing symlink cron destination')
    if destination.exists():
        st = destination.stat()
        if st.st_uid != 0 or st.st_mode & 0o022 or destination.read_text() != content:
            raise ValueError('existing cron differs or has unsafe ownership; manual review required')
        print('root cron already installed; unchanged')
        return 0
    fd, name = tempfile.mkstemp(prefix='.utxo-blk-', dir=destination.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            os.fchmod(f.fileno(), 0o644)
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        # Atomic publication without replacement; races fail, never overwrite cron.
        os.link(name, destination)
        d = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(d)
        finally:
            os.close(d)
    finally:
        os.unlink(name)
    print('root cron installed; no updater executed')
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__)
    mode = p.add_mutually_exclusive_group()
    mode.add_argument('--run', action='store_true', help='execute on node; default only prints cron proposal')
    mode.add_argument('--install-root-cron', action='store_true', help='explicit root-only idempotent cron.d installation')
    p.add_argument('--config', type=Path, default=Path('/home/umbrel/buv_v3_patch/buv_node_checkpoint_v3.json'))
    p.add_argument('--lock', type=Path, default=Path('/home/umbrel/buv_data/.daily-blk-update.lock'))
    a = p.parse_args()
    try:
        if a.install_root_cron:
            return install_root_cron(a.config, a.lock)
        if not a.run:
            print(cron_line(Path(__file__).resolve(), a.config, a.lock, root=True))
            return 0
        return run(a.config, a.lock)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
        print(str(e), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
