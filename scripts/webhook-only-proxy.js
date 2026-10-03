const http = require('node:http');

const port = Number(process.env.WEBHOOK_PROXY_PORT || 18789);
const upstreamPort = Number(process.env.PORT || 18787);
const routes = new Set([
  '/api/check-availability',
  '/api/book-appointment',
  '/api/cancel-appointment',
]);

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return response.end('Booking webhook endpoint');
  }
  if (request.method !== 'POST' || !routes.has(request.url)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return response.end('Not found');
  }
  if (!request.headers['x-agent-secret'] || !request.headers['x-salon-id']) {
    response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    return response.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
  }

  let body = Buffer.alloc(0);
  try {
    for await (const chunk of request) {
      body = Buffer.concat([body, chunk]);
      if (body.length > 100_000) {
        response.writeHead(413);
        return response.end();
      }
    }
  } catch {
    response.writeHead(400);
    return response.end();
  }

  const upstream = http.request({
    hostname: '127.0.0.1',
    port: upstreamPort,
    path: request.url,
    method: 'POST',
    timeout: 10_000,
    headers: {
      'content-type': 'application/json',
      'content-length': String(body.length),
      'x-agent-secret': request.headers['x-agent-secret'],
      'x-salon-id': request.headers['x-salon-id'],
    },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, {
      'content-type': upstreamResponse.headers['content-type'] || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    upstreamResponse.pipe(response);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('Upstream timeout')));
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  upstream.end(body);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Webhook-only proxy: http://127.0.0.1:${port}`);
});
