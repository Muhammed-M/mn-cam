#!/usr/bin/env python3
"""Download every photo from the R2 bucket (through the Worker's admin route).

    python3 tools/download_photos.py --worker https://mn-cam-upload.<you>.workers.dev

Asks for the ADMIN_KEY (never stored), then saves photos into
~/Pictures/Engagement-Photos/<guest-folder>/<photo>.jpg.
Safe to run again any time: photos already downloaded are skipped.
Standard library only — nothing to install.
"""
import argparse
import getpass
import json
import os
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

UA = "mn-cam-downloader/1.0"


def call(url, key):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}", "User-Agent": UA})
    return urllib.request.urlopen(req, timeout=60)


def list_all(worker, key):
    with call(f"{worker}/admin/list", key) as res:
        page = json.load(res)
    # Full-size photos only (thumbnails live under _thumbs/ and are skipped by the Worker).
    return [{"key": i["k"], "size": i["s"]} for i in page["items"]]


def fetch(worker, key, obj, out):
    dest = os.path.join(out, *obj["key"].split("/"))
    if os.path.exists(dest) and os.path.getsize(dest) == obj["size"]:
        return "skip"
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    with call(f"{worker}/admin/file/{urllib.parse.quote(obj['key'])}", key) as res, open(tmp, "wb") as f:
        while chunk := res.read(1 << 16):
            f.write(chunk)
    if os.path.getsize(tmp) != obj["size"]:
        os.remove(tmp)
        raise IOError(f"size mismatch for {obj['key']}")
    os.replace(tmp, dest)
    return "new"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--worker", required=True, help="Worker URL, e.g. https://mn-cam-upload.you.workers.dev")
    ap.add_argument("--out", default=os.path.expanduser("~/Pictures/Engagement-Photos"))
    args = ap.parse_args()
    worker = args.worker.rstrip("/")
    key = os.environ.get("MN_ADMIN_KEY") or getpass.getpass("ADMIN_KEY: ")

    try:
        objects = list_all(worker, key)
    except urllib.error.HTTPError as e:
        sys.exit("Wrong ADMIN_KEY." if e.code == 401 else f"Worker error: {e}")
    total_mb = sum(o["size"] for o in objects) / 1e6
    print(f"{len(objects)} photos in the bucket ({total_mb:.1f} MB) → {args.out}")

    counts = {"new": 0, "skip": 0, "fail": 0}
    with ThreadPoolExecutor(max_workers=6) as pool:
        jobs = {pool.submit(fetch, worker, key, o, args.out): o for o in objects}
        for i, job in enumerate(as_completed(jobs), 1):
            try:
                counts[job.result()] += 1
            except Exception as e:  # keep going; a re-run picks up failures
                counts["fail"] += 1
                print(f"\n  ! {jobs[job]['key']}: {e}")
            print(f"\r  {i}/{len(objects)}  new {counts['new']} · already had {counts['skip']} · failed {counts['fail']}", end="")
    print("\nDone." + (" Run again to retry the failed ones." if counts["fail"] else ""))


if __name__ == "__main__":
    main()
