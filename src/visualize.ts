import { createVisualizerServer, runVisualizerCli } from '@graphentra/visualizer';

export { createVisualizerServer, runVisualizerCli };

if (require.main === module) {
  runVisualizerCli();
}
