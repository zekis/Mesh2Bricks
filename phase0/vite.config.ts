import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// State sink: browser POSTs a JSON summary of the current pipeline state after
// each runPipeline. Written to .state/latest.json so the assistant can `Read`
// it directly without needing screenshots.
const stateSink: Plugin = {
  name: 'state-sink',
  configureServer(server) {
    const stateDir = path.resolve(__dirname, '.state');
    const stateFile = path.resolve(stateDir, 'latest.json');
    fs.mkdirSync(stateDir, { recursive: true });

    server.middlewares.use('/api/state', (req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.setEncoding('utf-8');
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            fs.writeFileSync(stateFile, body);
            res.statusCode = 204;
            res.end();
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
          }
        });
        return;
      }
      if (req.method === 'GET') {
        if (!fs.existsSync(stateFile)) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end('{"error":"no state yet — run the pipeline at least once"}');
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(fs.readFileSync(stateFile, 'utf-8'));
        return;
      }
      res.statusCode = 405;
      res.end();
    });
  },
};

export default defineConfig({
  base: './',
  server: { open: true, host: '127.0.0.1' },
  plugins: [stateSink],
});
