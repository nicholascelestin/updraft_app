"""Minimal dev server with Cross-Origin Isolation headers for SharedArrayBuffer / WASM threads."""

import http.server
import sys


class COIHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8081
print(f'Serving on http://localhost:{port} with cross-origin isolation headers')
http.server.HTTPServer(('', port), COIHandler).serve_forever()
