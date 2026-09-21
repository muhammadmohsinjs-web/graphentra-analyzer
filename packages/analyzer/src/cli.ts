#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyzeRepository } from './analyze';
import { parseCliOptions, resolveCliComparison } from './cli-options';
import { ANALYZER_VERSION } from './contracts';
import { GraphentraError } from './errors';
import { writeEvidenceFile } from './output';

export function runCli(argv: string[] = process.argv.slice(2)): void {
  let options;
  let comparison;
  try {
    options = parseCliOptions(argv);
    if (options.help) {
      console.log(`Graphentra Analyzer v${ANALYZER_VERSION}\nUsage: graphentra-analyze --target <dir> [--base <ref> --head <ref> | --working-tree] [--output <file>]\n--output names one evidence file (default: <target>/.graphentra/evidence.json).\n--help, -h   Show help\n--version, -v   Show version\nQA Markdown: npm run report -- --report <file>`);
      return;
    }
    if (options.version) { console.log(ANALYZER_VERSION); return; }
    comparison = resolveCliComparison(options, process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid command options.');
    process.exitCode = 2;
    return;
  }
  try {
    const target = path.resolve(options.target);
    const output = path.resolve(options.output ?? path.join(target, '.graphentra/evidence.json'));
    const result = analyzeRepository({ target, comparison });
    const canonical = (file: string): string => {
      if (fs.existsSync(file)) return fs.realpathSync(file);
      const parent = path.dirname(file);
      return parent === file ? file : path.join(canonical(parent), path.basename(file));
    };
    const destination = canonical(output);
    const protectedFiles = [...result.technicalGraph.analyzedFiles, 'tsconfig.json', 'package.json', '.graphentra/application-context.json'];
    if (protectedFiles.some(file => canonical(path.join(target, file)) === destination)) {
      throw new GraphentraError('Output collides with source, configuration, or persistent context.', 'INVALID_OPTIONS');
    }
    const published = writeEvidenceFile(output, result.evidence);
    console.log(`Deterministic evidence created: ${published}`);
    console.log(result.summaryMessage);
    for (const diagnostic of result.diagnostics) console.log(`[${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}`);
    for (const limitation of result.evidence.limitations) console.log(`Limitation: ${limitation}`);
  } catch (error) {
    const code = error instanceof GraphentraError ? error.code : 'OPERATION_FAILED';
    console.error(`Graphentra analysis failed [${code}]: ${error instanceof GraphentraError ? error.message : 'Could not analyze or publish evidence.'}`);
    process.exitCode = ['INVALID_OPTIONS', 'INVALID_REVISION', 'INVALID_TARGET'].includes(code) ? 2 : 1;
  }
}
if (require.main === module) runCli();
