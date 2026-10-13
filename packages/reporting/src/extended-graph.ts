import type { TechnicalGraph } from '@graphentra/analyzer';

/** True for graphs from the extended engine (evidence 2.1): they declare entity kinds beyond "function". */
export function isExtendedGraph(graph: Pick<TechnicalGraph, 'capabilities'>): boolean {
  return graph.capabilities.entityKinds.some(kind => kind !== 'function');
}
