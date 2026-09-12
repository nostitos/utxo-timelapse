#!/usr/bin/env python3
"""Temporary compatibility redirect from the legacy tunnel hostname to Cloudflare."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


DESTINATION = "https://utxo-cdn.hat39.com"


class RedirectHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _redirect(self) -> None:
        path = self.path if self.path.startswith("/") else f"/{self.path}"
        self.send_response(302)
        self.send_header("Location", f"{DESTINATION}{path}")
        self.send_header("Cache-Control", "public, max-age=300")
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()

    do_GET = _redirect
    do_HEAD = _redirect

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"{self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 12988), RedirectHandler).serve_forever()
