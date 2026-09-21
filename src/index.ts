export * from '@graphentra/analyzer';
export {
  ApplicationContext, Confidence, LegacyAnalysisResult as AnalysisResult, applicationContextSchema,
} from '@graphentra/reporting';
export { createVisualizerServer, runVisualizerCli } from '@graphentra/visualizer';
import { runReport } from '../tools/report';
export const run = runReport;
if (require.main === module) void run().catch(() => { console.error('Graphentra reporting failed.'); process.exitCode = 1; });
