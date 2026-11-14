"""Pinned Linux downloads. Only the ref pipeline and fast 8-layer decoder are selected."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import threading
import time

PREFIXES = ('transformer_ref/', 'text_encoder/', 'vae/', 'audio_vae/',
            'processor/', 'tokenizer/', 'scheduler/', 'audio_scheduler/')
CHUNK = 4 * 1024 * 1024


def selected_files(manifest, *, all_files=False):
    native=any(info['repo']=='MiniMaxAI/MiniMax-H3' for info in manifest)
    for info in manifest:
        for item in info['files']:
            name = item['path']
            if all_files:
                selected=True
            elif info['repo']=='MiniMaxAI/MiniMax-H3':
                selected=name.startswith(('Ref2VA/video_vae/','Ref2VA/audio_vae/'))
            elif 'QAD' in info['repo']:
                selected=name.startswith(PREFIXES) or '/' not in name and name.endswith('.json')
                if native and name.startswith(('vae/','audio_vae/')):selected=False
            else:
                selected=name in {'fast-8L/config.json', 'fast-8L/decoder-nvfp4.safetensors'}
            if not selected:
                continue
            if PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts:
                raise ValueError('Unsafe manifest path')
            yield info, item


def valid(path, item):
    if not path.is_file() or path.stat().st_size != item['size']:
        return False
    expected = (item.get('lfs') or {}).get('oid')
    if not expected:
        return True  # Small non-LFS configuration files have size metadata only.
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest() == expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('/root/autodl-tmp/fasth3/models'))
    parser.add_argument('--manifest', type=Path, default=Path(__file__).with_name('model-manifest.json'))
    parser.add_argument('--all-files', action='store_true', help='Select every file in an explicitly supplied pinned manifest instead of the FastH3 component subset')
    parser.add_argument('--plan', action='store_true')
    parser.add_argument('--progress', action='store_true', help='Show completed bytes from local resume records, without downloading or hashing')
    parser.add_argument('--verify-only', action='store_true')
    parser.add_argument('--exclude-path', action='append', default=[], help='Download only: exclude a path relative to model root')
    args = parser.parse_args()
    entries = list(selected_files(json.loads(args.manifest.read_text(encoding='utf-8-sig')), all_files=args.all_files))
    if args.exclude_path:
        if args.verify_only:
            parser.error('Verification must include the full pipeline')
        entries = [(info,item) for info,item in entries if not any(
            (info['repo'].split('/')[-1]+'/'+item['path']).startswith(prefix) for prefix in args.exclude_path)]
    total = sum(item['size'] for _, item in entries)
    print(f'Selected: {len(entries)} files; {total:,} bytes ({total/1e9:.2f} GB / {total/1024**3:.2f} GiB)', flush=True)
    if args.plan:
        for info, item in entries:
            print(info['repo'], info['sha'], item['path'], item['size'])
        return
    if args.progress:
        downloaded=0
        for info,item in entries:
            path=args.root/info['repo'].split('/')[-1]/item['path']
            control=path.with_name(path.name+'.aria2')
            if path.is_file() and path.stat().st_size==item['size'] and not control.exists():
                downloaded+=item['size']
                continue
            journal=path.with_name(path.name+'.ranges.json')
            partial=path.with_name(path.name+'.range-download')
            if journal.exists() and partial.exists():
                saved=json.loads(journal.read_text())
                chunk=saved.get('chunkSize',CHUNK) if isinstance(saved,dict) else 16*1024*1024
                done=saved['done'] if isinstance(saved,dict) else saved
                downloaded+=sum(min(chunk,item['size']-start) for start in set(done) if 0<=start<item['size'])
        print(json.dumps({'completedBytes':downloaded,'totalBytes':total,'percent':round(downloaded/total*100,1),
                          'remainingGB':round((total-downloaded)/1e9,2),'note':'Download progress; full pipeline SHA256 verification is separate.'}))
        return
    if os.name != 'posix':
        parser.error('Run download and verification on Linux; --plan works on Windows.')
    if args.verify_only:
        failures = [item['path'] for info, item in entries
                    if not valid(args.root/info['repo'].split('/')[-1]/item['path'], item)]
        if failures:
            raise RuntimeError('Missing or invalid files: ' + ', '.join(failures))
        print('MODEL_VERIFICATION_COMPLETE')
        return
    import requests
    workers = int(os.environ.get('DOWNLOAD_WORKERS', '32'))
    if not 1 <= workers <= 128:
        parser.error('DOWNLOAD_WORKERS must be 1..128')
    endpoint = os.environ.get('DOWNLOAD_ENDPOINT', 'https://hf-mirror.com').rstrip('/')
    args.root.mkdir(parents=True, exist_ok=True)
    missing_bytes = 0
    for info,item in entries:
        path = args.root/info['repo'].split('/')[-1]/item['path']
        partial = path.with_name(path.name+'.range-download')
        if not path.exists():
            allocated = partial.stat().st_blocks*512 if partial.exists() else 0
            missing_bytes += max(0,item['size']-allocated)
    if shutil.disk_usage(args.root).free < missing_bytes + 5*1024**3:
        raise RuntimeError('Insufficient free disk space for selected files plus 5 GiB reserve')
    files, jobs = [], []
    lock = threading.Lock()
    stop = threading.Event()
    started = time.monotonic()
    transferred = 0
    try:
        for info, item in entries:
            path = args.root/info['repo'].split('/')[-1]/item['path']
            if path.exists():
                if not valid(path, item):
                    raise RuntimeError(f'Invalid existing file; inspect it before replacing: {path}')
                print('Verified existing', item['path'], flush=True)
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            partial = path.with_name(path.name+'.range-download')
            journal = path.with_name(path.name+'.ranges.json')
            done = set()
            if partial.exists() and partial.stat().st_size == item['size'] and journal.exists():
                saved = json.loads(journal.read_text())
                previous_size = saved.get('chunkSize', CHUNK) if isinstance(saved, dict) else 16*1024*1024
                previous_done = saved['done'] if isinstance(saved, dict) else saved
                if previous_size % CHUNK:
                    raise RuntimeError('Unsupported download journal chunk size')
                done = {offset for start in previous_done
                        for offset in range(start, min(start+previous_size, item['size']), CHUNK)}
            fd = os.open(partial, os.O_CREAT | os.O_RDWR, 0o600)
            os.ftruncate(fd, item['size'])
            state = dict(fd=fd, done=done, journal=journal, partial=partial, path=path, item=item,
                         url=f"{endpoint}/{info['repo']}/resolve/{info['sha']}/{item['path']}")
            files.append(state)
            for start in range(0, item['size'], CHUNK):
                if start not in done:
                    jobs.append((state, start, min(start+CHUNK, item['size'])-1))

        def download(job):
            nonlocal transferred
            state, start, end = job
            for attempt in range(6):
                if stop.is_set():
                    return
                try:
                    with requests.Session() as session:
                        session.trust_env = os.environ.get('DOWNLOAD_USE_PROXY') == '1'
                        deadline = time.monotonic()+600
                        # Refresh an expired signed redirect when a retry is needed.
                        url = state['url'] if attempt == 0 else state['url']+f'?download=true&retry={int(time.time())}'
                        with session.get(url, headers={'Range': f'bytes={start}-{end}'}, stream=True, timeout=(20, 45)) as response:
                            if response.status_code == 200 and start == 0 and end+1 == state['item']['size']:
                                pass
                            elif response.status_code != 206 or not response.headers.get('Content-Range', '').startswith(f'bytes {start}-{end}/'):
                                raise RuntimeError('Unexpected HTTP range response')
                            position = start
                            for block in response.iter_content(256*1024):
                                if stop.is_set():
                                    return
                                if time.monotonic() > deadline:
                                    raise TimeoutError('Range time budget exceeded')
                                if position+len(block) > end+1:
                                    raise RuntimeError('Oversized range')
                                view = memoryview(block)
                                while view:
                                    count = os.pwrite(state['fd'], view, position)
                                    if count <= 0:
                                        raise OSError('Short file write')
                                    view, position = view[count:], position+count
                            if position != end+1:
                                raise RuntimeError('Incomplete range')
                    with lock:
                        state['done'].add(start)
                        temp = state['journal'].with_suffix('.tmp')
                        temp.write_text(json.dumps({'chunkSize': CHUNK, 'done': sorted(state['done'])}))
                        temp.replace(state['journal'])
                        transferred += end-start+1
                        if len(state['done']) % 8 == 0:
                            print(f'This run: {transferred/1e9:.2f} GB, {transferred/(time.monotonic()-started)/1e6:.1f} MB/s', flush=True)
                    return
                except (requests.RequestException, TimeoutError, RuntimeError) as failure:
                    if attempt in {0,4}:
                        print(f"Retry {attempt+1}: {state['item']['path']} range {start} ({type(failure).__name__})",flush=True)
                    if attempt == 5:
                        raise RuntimeError(f"Download failed: {state['item']['path']} range {start}; rerun to resume") from None
                    if stop.wait(min(2**attempt, 20)):
                        return

        print(f'Downloading {len(jobs)} ranges with {workers} workers', flush=True)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(download, job) for job in jobs]
            try:
                for future in as_completed(futures):
                    future.result()
            except BaseException:
                stop.set()
                for future in futures:
                    future.cancel()
                raise
        for state in files:
            os.fsync(state['fd'])
            os.close(state['fd'])
            state['fd'] = None
            if not valid(state['partial'], state['item']):
                state['journal'].unlink(missing_ok=True)
                raise RuntimeError('SHA256 verification failed: '+state['item']['path'])
            state['partial'].replace(state['path'])
            state['journal'].unlink(missing_ok=True)
            print('Verified', state['item']['path'], flush=True)
        print('MODEL_DOWNLOAD_COMPLETE', flush=True)
    finally:
        for state in files:
            if state['fd'] is not None:
                os.close(state['fd'])


if __name__ == '__main__':
    main()
