# SPDX-License-Identifier: AGPL-3.0-or-later
"""Static server for the browser page during development: like `python -m http.server`, but with
`Cache-Control: no-cache` so the browser revalidates the ES modules (and the worker's imports) on
every load instead of caching them heuristically.

    python browser/serve.py [port]      # serves this folder on 127.0.0.1
"""
import functools
import http.server
import os
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
    handler = functools.partial(NoCache, directory=os.path.dirname(os.path.abspath(__file__)))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as srv:
        print(f"serving {handler.keywords['directory']} on http://127.0.0.1:{port}/", flush=True)
        srv.serve_forever()
