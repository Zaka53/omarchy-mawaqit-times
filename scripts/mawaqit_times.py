#!/usr/bin/env python3
"""Fetch today's prayer times for a mosque from mawaqit.net.

Usage: mawaqit_times.py <mosque-slug-or-url>

Prints a single JSON object to stdout and always exits 0 so the caller
(the Quickshell Process running this script) can rely on stdout alone:
  {"ok": true, "name": ..., "timezone": ..., "labels": [...], "times": [...],
   "shuruq": "06:16", "jumua": "13:00", "fetchedAtEpochMs": 1700000000000,
   "nowLocalMinutes": 275}
  {"ok": false, "error": "..."}
"""

import json
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

LABELS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"]


def fail(message):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(0)


def mosque_slug(raw):
    raw = raw.strip()
    match = re.search(r"mawaqit\.net/[a-z]{2}/(?:m/)?([^/?#]+)", raw)
    return match.group(1) if match else raw


def extract_conf_data(html):
    marker = re.search(r"(?:let|var)\s+confData\s*=\s*\{", html)
    if not marker:
        return None

    start = html.index("{", marker.start())
    depth = 0
    in_string = False
    escape = False
    quote = ""
    for i in range(start, len(html)):
        ch = html[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == quote:
                in_string = False
        elif ch in ('"', "'"):
            in_string = True
            quote = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return html[start:i + 1]
    return None


def fetch(slug):
    url = f"https://mawaqit.net/en/{slug}"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            fail(f"No mosque found for '{slug}'")
        fail(f"mawaqit.net returned HTTP {e.code}")
    except urllib.error.URLError as e:
        fail(f"Could not reach mawaqit.net: {e.reason}")


def main():
    if len(sys.argv) != 2 or not sys.argv[1].strip():
        fail("Usage: mawaqit_times.py <mosque-slug-or-url>")

    slug = mosque_slug(sys.argv[1])
    html = fetch(slug)

    raw = extract_conf_data(html)
    if raw is None:
        fail("Could not find prayer time data on the mosque page")

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        fail("Could not parse prayer time data from the mosque page")

    times = data.get("times")
    if not isinstance(times, list) or len(times) != 5:
        fail("Mosque page did not include today's prayer times")

    timezone = data.get("timezone") or "UTC"
    try:
        now_dt = datetime.now(ZoneInfo(timezone))
    except Exception:
        timezone = "UTC"
        now_dt = datetime.now(ZoneInfo(timezone))
    now_local_minutes = now_dt.hour * 60 + now_dt.minute

    print(json.dumps({
        "ok": True,
        "slug": slug,
        "name": data.get("name") or slug,
        "timezone": timezone,
        "labels": LABELS,
        "times": times,
        "shuruq": data.get("shuruq") or "",
        "jumua": data.get("jumua") or "",
        "fetchedAtEpochMs": int(now_dt.timestamp() * 1000),
        "nowLocalMinutes": now_local_minutes,
    }))


if __name__ == "__main__":
    main()
