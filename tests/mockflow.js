// Stands in for Power Automate: captures envelopes to /tmp/flow-captured.jsonl
// and acknowledges immediately, the way a real flow does before it starts
// waiting on a human.
const http = require('http'); const fs = require('fs');
http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c);
  req.on('end', () => {
    const rec = { path: req.url, headers: req.headers, body: JSON.parse(b || '{}'), at: new Date().toISOString() };
    fs.appendFileSync('/tmp/flow-captured.jsonl', JSON.stringify(rec) + '\n');
    console.log(`[mockflow] ${req.url} <- ${rec.body.event} ${rec.body.jobId || ''}`);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end('{"accepted":true}');
  });
}).listen(3222, '127.0.0.1', () => console.log('[mockflow] :3222'));
