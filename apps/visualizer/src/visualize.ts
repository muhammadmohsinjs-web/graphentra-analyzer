import { validateEvidenceEnvelope, computeEvidenceIdentity } from './evidence';
export { validateEvidenceEnvelope, computeEvidenceIdentity } from './evidence';
#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/model.mjs', ['model.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readArtifact(directory: string, filename: string) {
  const file = path.join(directory, filename);
  const data: unknown = JSON.parse(await readFile(file, 'utf8'));
  const version = filename === 'analysis.json' ? '1.1' : '1.0';
  if (!isObject(data) || data.schemaVersion !== version) {
    throw new Error(`Expected schemaVersion ${version}.`);
  }
  const arrays =
    filename === 'technical-graph.json'
      ? ['entities', 'relations']
      : filename === 'analysis.json'
        ? ['changedFiles', 'changedEntities', 'impacts']
        : ['domains', 'entityAnnotations'];
  if (arrays.some(key => !Array.isArray(data[key]))) {
    throw new Error(`Expected arrays: ${arrays.join(', ')}.`);
  }
  if (filename === 'application-context.json') {
    if (!isObject(data.application)) throw new Error('Expected an application object.');
  } else if (
    !isObject(data.repository) ||
    typeof data.repository.headSha !== 'string' ||
    !data.repository.headSha
  ) {
    throw new Error('Expected repository.headSha.');
  }
  return { data, mtimeMs: (await stat(file)).mtimeMs };
}

async function readEvidenceArtifact(directory: string) {
  const file = path.join(directory, 'evidence.json');
  const data: unknown = JSON.parse(await readFile(file, 'utf8'));
  const validation = validateEvidenceEnvelope(data);
  if (!validation.valid) throw new Error(validation.errors.join('; '));
  return { data, mtimeMs: (await stat(file)).mtimeMs };
}

export function createVisualizerServer(
  options: { target?: string; visualizerDirectory?: string } = {},
) {
  const directory = path.resolve(options.target ?? process.cwd(), '.graphentra');
  const visualizerDirectory = options.visualizerDirectory ?? path.join(__dirname, '../public');

  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    const json = (status: number, body: unknown) => {
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(body));
    };

    const host = request.headers.host;
    const port = request.socket.localPort;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      json(403, {
        error:
          'Unexpected Host. Use the localhost or 127.0.0.1 URL with the listening port.',
      });
      return;
    }
    if (
      (request.headers.origin !== undefined &&
        request.headers.origin !== `http://${host}`) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    ) {
      json(403, { error: 'Cross-origin requests are not allowed.' });
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      json(405, { error: 'Only GET requests are supported.' });
      return;
    }

    // Match the raw path, not a URL-normalized path that could hide traversal.
    const route = (request.url ?? '').split('?')[0];
    if (route === '/api/data') {
      let evidenceArtifact: { data: any; mtimeMs: number } | undefined;
      try { evidenceArtifact = await readEvidenceArtifact(directory); }
      catch (error: any) {
        if (error.code !== 'ENOENT') {
          json(error.code ? 500 : 422, { error: 'Cannot load evidence.json. Regenerate it with the analyzer.' });
          return;
        }
      }
      if (evidenceArtifact) {
        const evidence = evidenceArtifact.data;
        const tg = evidence.technicalGraph as Record<string, unknown>;
        const warnings: string[] = [];

        // Build analysis object from evidence
        const analysis: Record<string, unknown> = {
          schemaVersion: '1.1',
          repository: { headSha: (tg.repository as any)?.headSha },
          changedFiles: evidence.changedFiles,
          changedEntities: evidence.changedEntities,
          impacts: evidence.impacts,
          limitations: evidence.limitations,
        };

        try {
          const legacy = (await readArtifact(directory, 'analysis.json')).data;
          const qa = legacy.qaReport;
          const validReport = isObject(qa) && typeof qa.summary === 'string' &&
            ['keyChanges', 'qaChecks', 'uncertainty'].every(key => Array.isArray(qa[key]) && (qa[key] as unknown[]).every(item => typeof item === 'string'));
          if (legacy.evidenceIdentity === computeEvidenceIdentity(evidence) && validReport) analysis.qaReport = qa;
          else warnings.push('Optional QA report identity or shape does not match this evidence; it was ignored.');
        } catch (error: any) {
          if (error.code !== 'ENOENT') warnings.push('Optional QA report could not be loaded.');
        }

        let context: Record<string, unknown> | null = null;
        try {
          context = (await readArtifact(directory, 'application-context.json')).data;
        } catch (error) {
          warnings.push(
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'Optional application-context.json is missing.'
              : `Optional application-context.json could not be loaded: ${error instanceof Error ? error.message : ''}`,
          );
        }

        json(200, {
          graph: tg,
          analysis,
          evidence,
          context,
          warnings,
        });
        return;
      }

      // Legacy fallback when evidence.json is absent
      let graph: Record<string, unknown>;
      try {
        graph = (await readArtifact(directory, 'technical-graph.json')).data;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        json(code === 'ENOENT' ? 404 : code ? 500 : 422, {
          error:
            code === 'ENOENT'
              ? `Missing technical-graph.json in ${directory}. Run the analyzer for this target first.`
              : `Cannot load technical-graph.json. Regenerate it with the analyzer. ${error instanceof Error ? error.message : ''}`,
        });
        return;
      }

      const warnings: string[] = [];
      let analysis: Record<string, unknown> | null = null;
      let context: Record<string, unknown> | null = null;
      for (const filename of ['analysis.json', 'application-context.json']) {
        try {
          const artifact = await readArtifact(directory, filename);
          if (filename === 'application-context.json') {
            context = artifact.data;
            continue;
          }
          const graphRepository = graph.repository as Record<string, unknown>;
          const analysisRepository = artifact.data.repository as Record<string, unknown>;
          if (analysisRepository.headSha !== graphRepository.headSha) {
            warnings.push(
              'analysis.json headSha does not match the graph; analysis was ignored.',
            );
            continue;
          }
          analysis = artifact.data;
          warnings.push(
            'Matching headSha values do not prove working-tree alignment between the graph and analysis.',
          );
          if (
            typeof graphRepository.generatedAt === 'string' &&
            Date.parse(graphRepository.generatedAt) > artifact.mtimeMs
          ) {
            warnings.push(
              'The graph generatedAt is later than the analysis.json modification time; analysis is potentially stale.',
            );
          }
        } catch (error) {
          warnings.push(
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? `Optional ${filename} is missing.`
              : `Optional ${filename} could not be loaded and was ignored. ${error instanceof Error ? error.message : ''}`,
          );
        }
      }
      json(200, { graph, analysis, context, warnings });
      return;
    }

    const asset = staticFiles.get(route);
    if (!asset) {
      json(404, { error: 'Not found.' });
      return;
    }
    try {
      const contents = await readFile(path.join(visualizerDirectory, asset[0]));
      response.writeHead(200, { 'Content-Type': asset[1] });
      response.end(contents);
    } catch {
      json(404, {
        error:
          'Visualizer asset not found. Ensure the visualizer directory is installed alongside src or dist.',
      });
    }
  });
}

export function runVisualizerCli(args: string[] = process.argv.slice(2)): void {
  try {
    let target: string | undefined;
    let port = 4173;
    let hasPort = false;
    for (let i = 0; i < args.length; i++) {
      const argument = args[i];
      if (argument === '--port' || argument.startsWith('--port=')) {
        if (hasPort) throw new Error('--port may only be provided once.');
        const value =
          argument === '--port' ? args[++i] : argument.slice('--port='.length);
        if (
          !value ||
          !/^\d+$/.test(value) ||
          Number(value) < 1 ||
          Number(value) > 65535
        ) {
          throw new Error('--port must be an integer from 1 to 65535.');
        }
        port = Number(value);
        hasPort = true;
      } else if (argument.startsWith('-')) {
        throw new Error(`Unknown option: ${argument}`);
      } else {
        if (target !== undefined) throw new Error('Provide only one target directory.');
        target = argument;
      }
    }
    const server = createVisualizerServer({ target });
    server.on('error', (error: NodeJS.ErrnoException) => {
      console.error(`Cannot start visualizer on 127.0.0.1:${port}: ${error.message}`);
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(
        `Visualizer: http://127.0.0.1:${port} (target: ${path.resolve(target ?? process.cwd())})`,
      );
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Usage: npm run visualize -- [target-directory] [--port 4173]');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runVisualizerCli();
}
