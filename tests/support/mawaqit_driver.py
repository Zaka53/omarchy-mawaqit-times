"""Runs mawaqit_times.main() offline for tests/helpers.test.js.

Usage: mawaqit_driver.py <path-to-mawaqit_times.py> <scenario-json> [<arg>...]
(the mosque goes on stdin, as with the real helper; extra args are passed on
so the helper's own argv check can be exercised)

The helper's open_url() is swapped for a fake chosen by the scenario, so the
real parsing / bounding / error paths run without touching the network:
  {"body_file": path}       respond with that file's bytes
  {"body_size": n}          respond with n bytes of padding
  {"http_error": code}      raise HTTPError(code)
  {"url_error": reason}     raise URLError(reason)
  {"stall_seconds": n}      block for n seconds before answering (deadline tests)
Optional extras: "deadline" overrides FETCH_DEADLINE_SECONDS, and
"sleep_after" sleeps that long after the page was read, before parsing.
Also records the URL that was requested and the byte count passed to
response.read(), printed to stderr as JSON for the test to inspect.
"""

import importlib.util
import io
import json
import sys
import time
import urllib.error
import urllib.request

sys.dont_write_bytecode = True  # keep test runs from leaving scripts/__pycache__ behind
script, scenario = sys.argv[1], json.loads(sys.argv[2])
seen = {}


class FakeResponse(io.BytesIO):
    def read(self, n=-1):
        seen["read_n"] = n
        return super().read(n)


def fake_urlopen(request, timeout=None):
    seen["url"] = request.full_url
    seen["timeout"] = timeout
    if "http_error" in scenario:
        raise urllib.error.HTTPError(request.full_url, scenario["http_error"], "err", {}, None)
    if "stall_seconds" in scenario:
        time.sleep(scenario["stall_seconds"])
    if "url_error" in scenario:
        raise urllib.error.URLError(scenario["url_error"])
    if "body_file" in scenario:
        with open(scenario["body_file"], "rb") as f:
            return FakeResponse(f.read())
    return FakeResponse(b" " * scenario["body_size"])


spec = importlib.util.spec_from_file_location("mawaqit_times", script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.open_url = fake_urlopen
if "deadline" in scenario:
    module.FETCH_DEADLINE_SECONDS = scenario["deadline"]
if "sleep_after" in scenario:
    real_extract = module.extract_conf_data

    def slow_extract(html):
        time.sleep(scenario["sleep_after"])
        return real_extract(html)

    module.extract_conf_data = slow_extract

sys.argv = [script] + sys.argv[3:]  # normally empty: the mosque is on stdin
try:
    module.run()
finally:
    sys.stderr.write(json.dumps(seen))
