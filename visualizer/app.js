import { prepareData, buildTraversal, layoutGraph, edgeKey, isTest } from '/model.mjs';

const $ = id => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const text = (tag, value, className) => {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
};
const svg = (tag, attributes = {}) => {
  const element = document.createElementNS(svgNS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
};

async function main() {
  const response = await fetch('/api/data');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Could not load local artifacts.');
  const model = prepareData(data);
  const layout = layoutGraph(model.entities);
  const recorded = model.analysis?.impacts ?? [];
  let simulated = recorded.length === 0;
  let selectedSeeds = recorded.length ? [recorded[0].changedEntity.id] : [...model.entities.keys()].slice(0, 1);
  let traversal = buildTraversal(model, selectedSeeds, simulated);
  let selected = selectedSeeds[0];
  let layer = 0;
  let playing = false;
  let frame = 0;
  let progress = 0;
  let view = { x: 0, y: 0, width: layout.width, height: layout.height };
  const nodeElements = new Map();
  const edgeElements = new Map();
  const groupCounts = new Map();
  const miniNodes = new Map();
  const stage = $('graph');
  const world = $('world');

  $('repository').textContent = model.graph.repository?.root?.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? 'Local repository';
  $('revision').textContent = model.graph.repository?.headSha?.slice(0, 7) ?? 'unknown';
  $('function-count').textContent = model.entities.size;
  $('connection-count').textContent = model.relations.length;
  $('change-count').textContent = recorded.length;
  $('depth-limit').textContent = `Traversal limit / ${model.maxDepth} edges`;
  $('recorded-mode').disabled = recorded.length === 0;
  const warnings = [
    ...model.warnings,
    ...(model.analysis?.limitations ?? []).filter(value => typeof value === 'string'),
    'Only discovered named TypeScript functions and static CALLS edges are shown. Methods, arrow functions, dynamic calls and application surfaces are not modeled.',
    `Traversal stops at depth ${model.maxDepth}. The recorded artifacts do not identify a truncated frontier.`,
    'Test labels use filename heuristics, not measured coverage. Nothing here indicates a passing test or a confirmed regression.',
    'The graph describes the analyzer working tree; matching commit IDs cannot guarantee it matches the compared revisions.',
  ];
  $('warning-count').textContent = `${warnings.length} notes`;
  $('warnings').replaceChildren(...warnings.map(value => text('li', value)));

  const qa = model.analysis?.qaReport;
  if (typeof qa?.summary === 'string') {
    $('qa-content').append(text('p', qa.summary));
    const columns = text('div', '', 'qa-columns');
    for (const [title, values] of [['Key changes', qa.keyChanges], ['Suggested checks', qa.qaChecks]]) {
      const section = text('section', '');
      section.append(text('h3', title));
      const list = text('ul', '');
      list.append(...(Array.isArray(values) ? values : []).filter(value => typeof value === 'string').map(value => text('li', value)));
      section.append(list);
      columns.append(section);
    }
    $('qa-content').append(columns);
    for (const uncertainty of Array.isArray(qa.uncertainty) ? qa.uncertainty : []) {
      if (typeof uncertainty === 'string') $('qa-content').append(text('p', `Uncertainty: ${uncertainty}`));
    }
  } else {
    $('qa-content').append(text('p', 'No saved QA briefing is available. You can still explore the graph in what-if mode.'));
  }

  const defs = svg('defs');
  const marker = svg('marker', { id: 'impact-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' });
  marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#69bddd' }));
  defs.append(marker);
  stage.prepend(defs);
  for (const group of layout.groups) {
    world.append(svg('rect', { x: group.x, y: group.y, width: group.width, height: group.height, rx: 10, class: 'file-box' }));
    const label = svg('text', { x: group.x + 16, y: group.y + 25, class: 'file-label' });
    label.textContent = group.file.length > 39 ? `...${group.file.slice(-36)}` : group.file;
    const title = svg('title'); title.textContent = group.file; label.append(title);
    const count = svg('text', { x: group.x + 16, y: group.y + group.height - 12, class: 'file-count' });
    groupCounts.set(group.file, count);
    world.append(label, count);
  }
  for (const relation of model.relations) {
    // Render reverse CALLS direction: changed callee -> potentially affected caller.
    const from = layout.positions.get(relation.to);
    const to = layout.positions.get(relation.from);
    let d;
    if (from.x === to.x) {
      const x = from.x + from.width;
      const bend = x + 24 + Math.min(40, Math.abs(from.y - to.y) * .12);
      d = `M ${x} ${from.y + 17} C ${bend} ${from.y + 17}, ${bend} ${to.y + 17}, ${x} ${to.y + 17}`;
    } else {
      const forward = to.x > from.x;
      const x1 = from.x + (forward ? from.width : 0);
      const x2 = to.x + (forward ? 0 : to.width);
      const mid = (x1 + x2) / 2;
      d = `M ${x1} ${from.y + 17} C ${mid} ${from.y + 17}, ${mid} ${to.y + 17}, ${x2} ${to.y + 17}`;
    }
    const line = svg('path', { d, class: 'edge' });
    const title = svg('title');
    title.textContent = `${model.entities.get(relation.from).name} calls ${model.entities.get(relation.to).name}. Impact travels in reverse.`;
    line.append(title);
    const wave = svg('path', { d, class: 'wave', pathLength: 100 });
    edgeElements.set(edgeKey(relation.to, relation.from), { line, wave });
    world.append(line, wave);
  }
  for (const [id, entity] of model.entities) {
    const position = layout.positions.get(id);
    const node = svg('g', { transform: `translate(${position.x}, ${position.y})`, class: 'node', tabindex: 0, role: 'button', 'aria-label': `${entity.name}, ${entity.file}. Inspect evidence.` });
    node.append(svg('rect', { width: position.width, height: position.height, rx: 5 }), svg('circle', { cx: 13, cy: 17, r: 3 }));
    const label = svg('text', { x: 24, y: 21 });
    label.textContent = entity.name.length > 31 ? `${entity.name.slice(0, 28)}...` : entity.name;
    const title = svg('title'); title.textContent = `${entity.name}\n${entity.file}:${entity.startLine}-${entity.endLine}`;
    node.append(label, title);
    node.addEventListener('click', () => inspect(id));
    node.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspect(id); }
    });
    node.addEventListener('focus', () => {
      if (position.x < view.x || position.y < view.y || position.x + position.width > view.x + view.width || position.y + position.height > view.y + view.height) {
        view.x = position.x + position.width / 2 - view.width / 2;
        view.y = position.y + position.height / 2 - view.height / 2;
        setView();
      }
    });
    nodeElements.set(id, node);
    world.append(node);
  }
  $('minimap').setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
  for (const group of layout.groups) $('minimap').append(svg('rect', { x: group.x, y: group.y, width: group.width, height: group.height, rx: 10, class: 'mini-group' }));
  for (const [id, position] of layout.positions) {
    const node = svg('rect', { x: position.x, y: position.y, width: position.width, height: position.height, fill: '#485966' });
    miniNodes.set(id, node); $('minimap').append(node);
  }
  const miniViewport = svg('rect', { class: 'mini-viewport' });
  $('minimap').append(miniViewport);

  function setView() {
    stage.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
    for (const key of ['x', 'y', 'width', 'height']) miniViewport.setAttribute(key, view[key]);
  }
  function frameBounds(bounds) {
    const aspect = stage.clientWidth / Math.max(1, stage.clientHeight);
    let width = bounds.width + 70;
    let height = bounds.height + 110;
    if (width / height > aspect) height = width / aspect;
    else width = height * aspect;
    view = { x: bounds.x + bounds.width / 2 - width / 2, y: bounds.y + bounds.height / 2 - height / 2, width, height };
    setView();
  }
  function fit() { frameBounds({ x: 0, y: 0, width: layout.width, height: layout.height }); }
  function followWave() {
    if (!$('follow').checked) return;
    const positions = [...traversal.depths].filter(([, depth]) => depth === layer).map(([id]) => layout.positions.get(id));
    if (!positions.length || positions.every(p => p.x > view.x + 30 && p.y > view.y + 40 && p.x + p.width < view.x + view.width - 30 && p.y + p.height < view.y + view.height - 40)) return;
    const x = Math.min(...positions.map(p => p.x));
    const y = Math.min(...positions.map(p => p.y));
    frameBounds({ x, y, width: Math.max(...positions.map(p => p.x + p.width)) - x, height: Math.max(...positions.map(p => p.y + p.height)) - y });
  }
  function zoom(factor, cx = view.x + view.width / 2, cy = view.y + view.height / 2) {
    const width = view.width * factor;
    if (width < 180 || width > layout.width * 5) return;
    view = { x: cx - (cx - view.x) * factor, y: cy - (cy - view.y) * factor, width, height: view.height * factor };
    setView();
  }
  $('fit').onclick = fit;
  $('zoom-in').onclick = () => zoom(.8);
  $('zoom-out').onclick = () => zoom(1.25);
  stage.addEventListener('wheel', event => {
    event.preventDefault();
    $('follow').checked = false;
    const rect = stage.getBoundingClientRect();
    zoom(event.deltaY > 0 ? 1.12 : 1 / 1.12, view.x + (event.clientX - rect.left) / rect.width * view.width, view.y + (event.clientY - rect.top) / rect.height * view.height);
  }, { passive: false });
  let drag;
  stage.addEventListener('pointerdown', event => {
    if (event.target.closest('.node') || event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, view: { ...view } };
    $('follow').checked = false;
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', event => {
    if (!drag) return;
    view.x = drag.view.x - (event.clientX - drag.x) / stage.clientWidth * view.width;
    view.y = drag.view.y - (event.clientY - drag.y) / stage.clientHeight * view.height;
    setView();
  });
  stage.addEventListener('pointerup', () => { drag = null; });
  stage.addEventListener('pointercancel', () => { drag = null; });
  new ResizeObserver(fit).observe(stage);

  function renderSeeds() {
    const focusedId = document.activeElement?.dataset.seed;
    $('recorded-mode').classList.toggle('active', !simulated);
    $('whatif-mode').classList.toggle('active', simulated);
    $('recorded-mode').setAttribute('aria-pressed', String(!simulated));
    $('whatif-mode').setAttribute('aria-pressed', String(simulated));
    $('mode-badge').textContent = simulated ? 'WHAT-IF / SIMULATED' : 'RECORDED IMPACT';
    $('mode-description').textContent = simulated ? 'Choose any function to simulate a change. This is not a recorded result.' : 'Functions changed in the saved analysis.';
    $('all-changes').hidden = simulated || recorded.length < 2;
    $('all-changes').setAttribute('aria-pressed', String(!simulated && selectedSeeds.length === recorded.length));
    const query = $('search').value.toLowerCase();
    const candidates = simulated ? [...model.entities.values()] : recorded.map(impact => model.entities.get(impact.changedEntity.id));
    $('seed-list').replaceChildren();
    for (const entity of candidates.filter(entity => `${entity.name} ${entity.file}`.toLowerCase().includes(query))) {
      const button = text('button', '', `seed-button${selectedSeeds.includes(entity.id) ? ' selected' : ''}`);
      button.append(text('strong', entity.name), text('span', entity.file));
      button.setAttribute('aria-pressed', String(selectedSeeds.includes(entity.id)));
      button.dataset.seed = entity.id;
      button.onclick = () => choose([entity.id]);
      $('seed-list').append(button);
      if (focusedId === entity.id) button.focus({ preventScroll: true });
    }
    if (!$('seed-list').childElementCount) $('seed-list').append(text('p', 'No matching functions.', 'small'));
  }

  function render() {
    const reached = [...traversal.depths].filter(([id, depth]) => depth <= layer && !traversal.seeds.has(id));
    const affected = [...traversal.depths.keys()].filter(id => !traversal.seeds.has(id)).length;
    $('affected-count').textContent = affected;
    const highlightedPaths = traversal.paths.get(selected) ?? [];
    const tracedEdges = new Set(highlightedPaths.flatMap(path => path.slice(1).map((id, i) => edgeKey(path[i], id))));
    for (const [id, node] of nodeElements) {
      const depth = traversal.depths.get(id);
      const active = depth !== undefined && depth <= layer;
      const seed = traversal.seeds.has(id);
      node.setAttribute('class', ['node', isTest(model.entities.get(id).file) ? 'test' : '', seed ? 'seed' : '', active && !seed ? 'reached' : '', active && depth === layer && layer > 0 ? 'fresh' : '', selected === id ? 'selected' : ''].join(' '));
      node.setAttribute('aria-pressed', String(selected === id));
      miniNodes.get(id).setAttribute('class', seed ? 'mini-seed' : active ? 'mini-reached' : '');
    }
    for (const [key, { line }] of edgeElements) {
      const depth = traversal.edges.get(key);
      const active = depth !== undefined && depth <= layer;
      line.setAttribute('class', `edge${active ? ' reached' : ''}${active && tracedEdges.has(key) ? ' traced' : ''}`);
      if (active) line.setAttribute('marker-end', 'url(#impact-arrow)');
      else line.removeAttribute('marker-end');
    }
    for (const group of layout.groups) {
      const count = group.members.filter(entity => traversal.depths.has(entity.id) && traversal.depths.get(entity.id) <= layer && !traversal.seeds.has(entity.id)).length;
      groupCounts.get(group.file).textContent = count ? `${count} potentially affected / ${group.members.length} functions` : `${group.members.length} functions`;
    }
    $('timeline').max = traversal.maxLayer;
    $('timeline').value = layer;
    $('timeline').disabled = traversal.maxLayer === 0;
    $('layer-label').textContent = `DEPTH ${layer} / ${traversal.maxLayer}`;
    $('reached-label').textContent = `${reached.length} reached / ${new Set(reached.map(([id]) => model.entities.get(id).file)).size} files`;
    $('play').textContent = playing ? 'Pause' : layer === traversal.maxLayer && layer > 0 ? 'Play again' : 'Play wave';
    $('play').disabled = traversal.maxLayer === 0;
    $('replay').disabled = traversal.maxLayer === 0;
    $('previous').disabled = layer === 0;
    $('next').disabled = layer === traversal.maxLayer;
    $('playback-status').textContent = !traversal.seeds.size ? 'No discovered functions to explore.'
      : traversal.maxLayer === 0 ? 'No callers found within the discovered graph.'
        : layer === traversal.maxLayer ? `Traversal complete within the depth-${model.maxDepth} analysis boundary. Not execution or test coverage.`
          : layer === 0 ? 'Ready. Follow the change outward to its callers.' : `Depth ${layer}: ${reached.length} unique callers reached. Impact flows opposite to CALLS.`;
  }
  function stop() {
    playing = false; cancelAnimationFrame(frame);
    for (const { wave } of edgeElements.values()) { wave.setAttribute('class', 'wave'); wave.removeAttribute('stroke-dashoffset'); }
  }
  function play() {
    if (!traversal.maxLayer) return;
    if (layer >= traversal.maxLayer) { layer = 0; progress = 0; }
    playing = true;
    render();
    let previous;
    function tick(now) {
      if (!playing) return;
      previous ??= now;
      const duration = 1400 / Number($('speed').value);
      progress = Math.min(1, progress + (now - previous) / duration);
      previous = now;
      for (const [key, { wave }] of edgeElements) {
        const active = traversal.edges.get(key) === layer + 1 && !reducedMotion.matches;
        wave.setAttribute('class', active ? 'wave running' : 'wave');
        if (active) wave.setAttribute('stroke-dashoffset', String(100 - progress * 100));
      }
      if (progress === 1) {
        layer++; progress = 0; followWave();
        if (layer >= traversal.maxLayer) stop();
        render();
      }
      if (playing) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
  }
  function seek(value) { stop(); progress = 0; layer = Math.max(0, Math.min(traversal.maxLayer, value)); render(); followWave(); }
  function choose(ids) {
    stop(); progress = 0; selectedSeeds = ids; selected = ids[0]; layer = 0;
    traversal = buildTraversal(model, ids, simulated);
    renderSeeds(); render(); renderInspector();
  }
  function inspect(id) { stop(); selected = id; render(); renderInspector(); }
  function renderInspector() {
    const root = $('inspector'); root.replaceChildren();
    const entity = model.entities.get(selected);
    if (!entity) { root.append(text('p', 'Select a function to inspect its evidence.')); return; }
    const info = text('div', '');
    const depth = traversal.depths.get(selected);
    const seed = traversal.seeds.has(selected);
    info.append(text('span', seed ? simulated ? 'SIMULATED START' : 'CHANGED FUNCTION' : depth !== undefined ? `POTENTIAL IMPACT / DEPTH ${depth}` : 'GRAPH CONTEXT', 'badge'));
    info.append(text('h3', entity.name, 'inspector-name'), text('div', `${entity.file}:${entity.startLine}-${entity.endLine}`, 'file-location'));
    if (isTest(entity.file)) info.append(text('p', 'Test function (filename heuristic). No execution or coverage data.', 'small'));
    root.append(info);
    const pathSection = text('section', '', 'evidence-section');
    pathSection.append(text('h3', 'Why is this connected?'));
    const paths = traversal.paths.get(selected) ?? [];
    if (seed) pathSection.append(text('p', simulated ? 'You selected this function as a hypothetical change. The wave is computed from the current graph, not saved change evidence.' : 'This function is a starting point in the saved change analysis.'));
    else if (!paths.length) pathSection.append(text('p', 'Not reached from the selected starting point within the analyzed depth. This is not proof that it cannot be affected.'));
    else {
      pathSection.append(text('p', simulated ? 'Shortest caller path computed from the current graph.' : `${paths.length} recorded caller path${paths.length === 1 ? '' : 's'}. Arrows below show impact, not call direction.`));
      for (const path of paths.slice(0, 20)) {
        const list = text('div', '', 'path-list');
        for (const id of path) {
          const button = text('button', model.entities.get(id).name);
          button.onclick = () => { inspect(id); nodeElements.get(id).focus(); };
          list.append(button);
        }
        pathSection.append(list);
      }
      if (paths.length > 20) pathSection.append(text('p', `Showing 20 of ${paths.length} paths. All recorded paths remain included in the wave.`));
    }
    root.append(pathSection);
    const impact = recorded.find(item => item.changedEntity.id === selected);
    if (impact) {
      const section = text('section', '', 'evidence-section');
      section.append(text('h3', simulated ? 'Saved diff (separate from this simulation)' : 'What changed'));
      const diff = text('pre', '', 'diff');
      for (const line of impact.change.diff.split('\n')) {
        diff.append(text('span', line, line.startsWith('+') && !line.startsWith('+++') ? 'added' : line.startsWith('-') && !line.startsWith('---') ? 'removed' : line.startsWith('@@') ? 'hunk' : ''));
      }
      section.append(diff); root.append(section);
    }
    const annotation = model.context?.entityAnnotations?.find(item => item?.entityId === selected);
    if (typeof annotation?.businessMeaning === 'string') {
      const section = text('section', '', 'evidence-section');
      section.append(text('h3', 'Business context / AI annotation'), text('p', annotation.businessMeaning), text('p', `Annotation confidence: ${annotation.confidence ?? 'unknown'}. Not a regression-risk score; context may be stale.`));
      root.append(section);
    }
  }
  $('search').oninput = renderSeeds;
  $('recorded-mode').onclick = () => { simulated = false; choose(recorded.slice(0, 1).map(impact => impact.changedEntity.id)); };
  $('whatif-mode').onclick = () => { simulated = true; choose(selected ? [selected] : [...model.entities.keys()].slice(0, 1)); };
  $('all-changes').onclick = () => choose(recorded.map(impact => impact.changedEntity.id));
  $('play').onclick = () => { if (playing) { stop(); render(); } else play(); };
  $('replay').onclick = () => { seek(0); play(); };
  $('previous').onclick = () => seek(layer - 1);
  $('next').onclick = () => seek(layer + 1);
  $('timeline').oninput = () => seek(Number($('timeline').value));
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); render(); } });
  fit(); renderSeeds(); render(); renderInspector();
}

main().catch(error => {
  $('error').hidden = false;
  $('error').textContent = `${error.message} Start with: npm run visualize -- /path/to/analyzed-repository`;
  $('repository').textContent = 'Artifacts unavailable';
  document.querySelectorAll('.workspace button, .workspace input, .workspace select').forEach(element => { element.disabled = true; });
});
