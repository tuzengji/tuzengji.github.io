"""Read every published file over verified HTTPS and compare it to the release."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from pathlib import Path
import argparse
import json
import os
import time
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen


def verify(base, path, digest):
    # Test the public directory URL as well as the file hash (including /en/).
    route = path.removesuffix("index.html") if path.endswith("index.html") else path
    url = f"{base.rstrip('/')}/{quote(route)}?release={digest[:16]}"
    error = None
    for attempt in range(5):
        try:
            request = Request(url, headers={"User-Agent": "HomepageReleaseCheck/1.0"})
            with urlopen(request, timeout=25) as response:
                final = urlsplit(response.url)
                if final.scheme != "https" or final.netloc != urlsplit(base).netloc:
                    raise ValueError(f"Unexpected redirect to {response.url}")
                actual = sha256(response.read()).hexdigest()
                if response.status != 200 or actual != digest:
                    raise ValueError(f"HTTP {response.status}; SHA256 {actual} != {digest}")
            return {"site": base, "path": path, "sha256": digest, "verified": True}
        except Exception as exc:
            error = str(exc)
            if attempt < 4:
                time.sleep(3 * (attempt + 1))
    return {"site": base, "path": path, "verified": False, "error": error}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("sites", nargs="+")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    files = sorted(path for path in args.directory.rglob("*") if path.is_file() and path.name != ".DS_Store")
    if not files or any(path.is_symlink() for path in files):
        parser.error("Expected a nonempty release without symlinked files")
    if any(urlsplit(site).scheme != "https" for site in args.sites):
        parser.error("Only HTTPS destinations are supported")
    checks = [(site, path.relative_to(args.directory).as_posix(), sha256(path.read_bytes()).hexdigest())
              for site in args.sites for path in files]
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda check: verify(*check), checks))
    report = {"files_per_site": len(files), "sites": args.sites, "checks": results}
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
    for site in args.sites:
        matches = [row for row in results if row["site"] == site]
        passed = sum(row["verified"] for row in matches)
        print(f"{site}: {passed}/{len(matches)} files match over HTTPS", flush=True)
    for row in results:
        if not row["verified"]:
            print(f"FAIL {row['site']}/{row['path']}: {row['error']}", flush=True)
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary, "a") as out:
            out.write("| Website | Verified files |\n|---|---|\n")
            for site in args.sites:
                passed = sum(row["verified"] for row in results if row["site"] == site)
                out.write(f"| {site} | {passed}/{len(files)} |\n")
    return 0 if all(row["verified"] for row in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
