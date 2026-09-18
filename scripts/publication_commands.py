"""Opt-in immutable R2 publication and explicit release transaction.

Execution manifest (passed to publish_append prepare --execution-manifest):
  endpoint: HTTPS S3 endpoint; bucket: bucket; credentials: absolute INI path
  workers: 1..5 (default 5)
  additionalStages: optional list of {manifest: absolute publication.json,
      sha256: exact manifest hash}; uploaded before any playlist or deployment
  info: complete new info JSON; release: complete new release JSON, with sitePrefix
  deploy / rollback: nonempty lists of {argv: [strings], cwd: absolute directory,
      timeoutSeconds: positive number}. No shell. Supported argv placeholders:
      {stage}, {release}, {info}; rollback argv must explicitly identify old release.
  beforeChecks / afterChecks / rollbackChecks: nonempty lists, each including:
      {kind: "info", url: HTTPS URL, expected: nonempty JSON object}
      {kind: "range", url: HTTPS URL, start: int, end: int, total: int,
       sha256: SHA256 of exactly the expected range bytes}
  info checks compare supplied top-level fields exactly (nested values exact).

All local hashes/check schemas are validated before any network activity. Old
objects are trusted ONLY via the previous ledger pin and never HEADed/uploaded.
New objects use conditional create and SHA256 metadata, MD5 ETag and size checks.
An existing object lacking matching metadata is refused, not overwritten.
Uploads precede deployment. Any deployment/after-check failure runs rollback and
rollbackChecks, preserving both errors if rollback fails. Uploaded immutable
orphans are deliberately not deleted. Journaled interrupted deployments require
explicit recover_publication() / CLI rollback; automatic execute retry refuses.
This is not a distributed deployment lock: external release writers must be
serialized by the operator. Prior checks are repeated immediately before deploy.
"""
import concurrent.futures
import fcntl
import hashlib
import json
from pathlib import Path
import subprocess
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from fragment_manifest import atomic_json, load_previous, verify


def _https(value):
    parsed = urlsplit(value)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError('HTTPS URL required')


def _key(key):
    if not isinstance(key, str) or any(p in ('', '.', '..') for p in key.split('/')) or any(c in key for c in '\\?\r\n#'):
        raise ValueError('unsafe immutable key')


def validate_checks(checks):
    if not isinstance(checks, list) or {c.get('kind') for c in checks} != {'info', 'range'}:
        raise ValueError('both info and range checks required')
    for check in checks:
        _https(check['url'])
        expected_headers = check.get('expectedHeaders', {})
        if not isinstance(expected_headers, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in expected_headers.items()):
            raise ValueError('expectedHeaders must map strings to strings')
        if check['kind'] == 'info':
            if not isinstance(check['expected'], dict) or not check['expected']:
                raise ValueError('explicit info expectations required')
        else:
            if any(type(check[k]) is not int for k in ('start', 'end', 'total')) or not 0 <= check['start'] <= check['end'] < check['total']:
                raise ValueError('invalid expected range')
            digest = check['sha256']
            if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
                raise ValueError('explicit range digest required')


def validate_execution(config):
    _https(config['endpoint'])
    if not config['bucket'] or not Path(config['credentials']).is_absolute():
        raise ValueError('bucket and absolute credentials required')
    workers = config.get('workers', 5)
    if type(workers) is not int or not 1 <= workers <= 5:
        raise ValueError('upload workers must be 1..5')
    if not isinstance(config['info'], dict) or not config['info'] or not isinstance(config['release'], dict):
        raise ValueError('complete explicit info/release required')
    _key(config['release']['sitePrefix'])
    additional = config.get('additionalStages', [])
    if not isinstance(additional, list):
        raise ValueError('additionalStages must be a list')
    for stage in additional:
        if (not isinstance(stage, dict) or not Path(stage.get('manifest', '')).is_absolute() or
                not isinstance(stage.get('sha256'), str) or len(stage['sha256']) != 64 or
                any(c not in '0123456789abcdef' for c in stage['sha256'])):
            raise ValueError('additional stage requires absolute manifest and SHA256')
    for phase in ('deploy', 'rollback'):
        commands = config[phase]
        if not isinstance(commands, list) or not commands:
            raise ValueError('explicit deploy and rollback argv required')
        for command in commands:
            argv = command['argv']
            if not isinstance(argv, list) or not argv or any(not isinstance(v, str) or not v or '\0' in v for v in argv):
                raise ValueError('command must be an argv array')
            if not Path(command['cwd']).is_absolute() or not Path(command['cwd']).is_dir():
                raise ValueError('existing absolute command cwd required')
            timeout = command.get('timeoutSeconds', 300)
            if type(timeout) not in (int, float) or not 0 < timeout <= 3600:
                raise ValueError('bounded command timeout required')
    for phase in ('beforeChecks', 'afterChecks', 'rollbackChecks'):
        validate_checks(config[phase])


def check_public(checks, *, opener=urlopen):
    for check in checks:
        headers = {'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity',
                   'User-Agent': 'UTXO-Timelapse-Publication/1.0'}
        if check['kind'] == 'range':
            headers['Range'] = f"bytes={check['start']}-{check['end']}"
        with opener(Request(check['url'], headers=headers), timeout=30) as response:
            if response.geturl() != check['url']:
                raise ValueError('unexpected verification redirect')
            for name, expected in check.get('expectedHeaders', {}).items():
                if response.headers.get(name) != expected:
                    raise ValueError('public header mismatch: '+name)
            if check['kind'] == 'info':
                if response.status != 200:
                    raise ValueError('info status mismatch')
                body = response.read(1024*1024+1)
                if len(body) > 1024*1024:
                    raise ValueError('info response too large')
                actual = json.loads(body)
                if any(k not in actual or actual[k] != v for k, v in check['expected'].items()):
                    raise ValueError('public info mismatch')
            else:
                length = check['end']-check['start']+1
                expected_range = f"bytes {check['start']}-{check['end']}/{check['total']}"
                if response.status != 206 or response.headers.get('Content-Range') != expected_range:
                    raise ValueError('Range status/header mismatch')
                body = response.read(length+1)
                if len(body) != length or hashlib.sha256(body).hexdigest() != check['sha256']:
                    raise ValueError('Range payload mismatch')


def make_client(config):
    import boto3
    from botocore.config import Config
    from r2_publish_cloud_history import load_credentials
    access, secret = load_credentials(Path(config['credentials']))
    return boto3.client('s3', endpoint_url=config['endpoint'], aws_access_key_id=access,
                        aws_secret_access_key=secret, region_name='auto',
                        config=Config(max_pool_connections=5, connect_timeout=20,
                                      read_timeout=300, retries={'max_attempts': 8, 'mode': 'adaptive'}))


def _body(root, entry):
    name = entry['file']
    if Path(name).name != name or name in ('', '.', '..'):
        raise ValueError('unsafe staged file')
    body = (root/name).read_bytes()
    if len(body) != entry['bytes'] or hashlib.sha256(body).hexdigest() != entry['sha256']:
        raise ValueError('staged object integrity failure')
    return body


def upload_immutable(client, bucket, entry, body):
    md5 = hashlib.md5(body).hexdigest()
    def matches(head):
        if (head['ContentLength'] != len(body) or head['ETag'].strip('"') != md5 or
                head.get('Metadata', {}).get('sha256') != entry['sha256']):
            raise ValueError('immutable object conflict: '+entry['key'])
    try:
        head = client.head_object(Bucket=bucket, Key=entry['key'])
    except Exception as exc:
        if getattr(exc, 'response', {}).get('ResponseMetadata', {}).get('HTTPStatusCode') != 404:
            raise
    else:
        matches(head)
        return
    import base64
    content_type = ('application/vnd.apple.mpegurl' if entry['file'].endswith('.m3u8') else
                    'application/json' if entry['file'].endswith('.json') else
                    'text/html; charset=utf-8' if entry['file'].endswith('.html') else
                    'text/javascript; charset=utf-8' if entry['file'].endswith('.js') else
                    'text/plain; charset=utf-8' if entry['file'].endswith('.LICENSE') else
                    'video/mp4' if entry['file'].endswith('.mp4') else 'video/iso.segment')
    try:
        client.put_object(Bucket=bucket, Key=entry['key'], Body=body, ContentLength=len(body),
                          ContentMD5=base64.b64encode(bytes.fromhex(md5)).decode(),
                          Metadata={'sha256': entry['sha256']}, IfNoneMatch='*',
                          ContentType=content_type, CacheControl='public,max-age=31536000,immutable')
    except Exception as exc:
        if getattr(exc, 'response', {}).get('ResponseMetadata', {}).get('HTTPStatusCode') != 412:
            raise
    matches(client.head_object(Bucket=bucket, Key=entry['key']))


def run_commands(commands, root):
    substitutions = {'{stage}': str(root), '{release}': str(root/'release.json'), '{info}': str(root/'info.json')}
    for command in commands:
        argv = command['argv'][:]
        for token, value in substitutions.items():
            argv = [arg.replace(token, value) for arg in argv]
        subprocess.run(argv, cwd=command['cwd'], timeout=command.get('timeoutSeconds', 300),
                       check=True, shell=False)


def validate_stage(root, plan):
    previous = load_previous(root/'previous.json', plan['previousSHA256']) if 'previousSHA256' in plan else None
    if hashlib.sha256((root/'segments.json').read_bytes()).hexdigest() != plan['ledgerSHA256']:
        raise ValueError('staged ledger digest mismatch')
    verify(root, previous=previous)
    return [(root, entry) for entry in plan['objects']], [(root, plan['playlist'])]


def execute_publication(manifest, *, expected_sha256, client=None, checker=check_public, runner=run_commands):
    root = Path(manifest).resolve().parent
    raw = Path(manifest).read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError('publication manifest digest mismatch')
    plan = json.loads(raw)
    config = plan['execution']
    validate_execution(config)
    with (root/'.publication.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        journal = root/'execution-state.json'
        if journal.exists():
            raise ValueError('execution already attempted; inspect journal and explicitly recover before a fresh staging run')
        objects, playlists = validate_stage(root, plan)
        for reference in config.get('additionalStages', []):
            path = Path(reference['manifest'])
            body = path.read_bytes()
            if hashlib.sha256(body).hexdigest() != reference['sha256']:
                raise ValueError('additional stage manifest digest mismatch')
            additional = json.loads(body)
            if 'execution' in additional:
                raise ValueError('additional stage cannot deploy or nest stages')
            more_objects, more_playlists = validate_stage(path.parent, additional)
            objects.extend(more_objects)
            playlists.extend(more_playlists)
        entries = [*objects, *playlists]
        seen = set()
        for entry_root, entry in entries:
            _key(entry['key'])
            if entry['key'] in seen:
                raise ValueError('duplicate upload key')
            seen.add(entry['key'])
            _body(entry_root, entry)
        checker(config['beforeChecks'])
        client = make_client(config) if client is None else client
        def state(phase, **fields):
            atomic_json(journal, dict(manifestSHA256=expected_sha256, phase=phase, **fields))
        state('uploading')
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=config.get('workers', 5)) as pool:
                # At most workers complete fragment bodies in memory at once.
                def upload(item):
                    entry_root, entry = item
                    upload_immutable(client, config['bucket'], entry, _body(entry_root, entry))
                list(pool.map(upload, objects))
            for item in playlists:
                upload(item)
            checker(config['beforeChecks'])
        except Exception as exc:
            state('upload_failed', error=str(exc))
            raise
        state('deploying')  # Durable intent before potentially partial command side effects.
        try:
            runner(config['deploy'], root)
            checker(config['afterChecks'])
        except BaseException as exc:
            try:
                state('rolling_back', error=str(exc))
                runner(config['rollback'], root)
                checker(config['rollbackChecks'])
                state('rolled_back', error=str(exc))
            except BaseException as rollback_error:
                state('rollback_failed', error=str(exc), rollbackError=str(rollback_error))
                raise RuntimeError(f'publication failed: {exc}; rollback failed: {rollback_error}') from rollback_error
            raise
        state('verified')
        return {'phase': 'verified', 'uploadedObjects': len(entries)}


def recover_publication(manifest, *, expected_sha256, checker=check_public, runner=run_commands):
    """Explicit rollback after interruption; never uploads or re-deploys."""
    root = Path(manifest).resolve().parent
    raw = Path(manifest).read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError('publication manifest digest mismatch')
    config = json.loads(raw)['execution']
    validate_execution(config)
    with (root/'.publication.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        journal = root/'execution-state.json'
        state = json.loads(journal.read_text())
        if state['manifestSHA256'] != expected_sha256 or state['phase'] not in ('deploying', 'rolling_back', 'rollback_failed'):
            raise ValueError('no interrupted deployment to recover')
        try:
            runner(config['rollback'], root)
            checker(config['rollbackChecks'])
        except BaseException as exc:
            atomic_json(journal, dict(state, phase='rollback_failed', rollbackError=str(exc)))
            raise
        atomic_json(journal, dict(state, phase='rolled_back'))
        return {'phase': 'rolled_back'}
