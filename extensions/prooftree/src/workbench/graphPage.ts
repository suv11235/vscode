/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { STATUS_LABEL } from '../ledger/format';
import { buildGraph, layoutGraph, NODE_HEIGHT, NODE_WIDTH } from '../ledger/graph';
import { ClaimReport } from '../ledger/status';
import { STATUS_STYLE } from './statusStyle';

/**
 * The knowledge graph webview's page and data, kept free of the VS Code API so the page can
 * also be rendered and tested on its own. Colors come from the theme's CSS variables.
 */

export function graphPayload(reports: ReadonlyMap<string, ClaimReport>) {
	const graph = buildGraph(reports);
	const layout = layoutGraph(graph);
	const nodes = layout.nodes.map(node => ({
		...node,
		color: node.status ? `var(--vscode-${STATUS_STYLE[node.status].color.replace('.', '-')})` : undefined,
		statusLabel: node.status ? STATUS_LABEL[node.status] : undefined,
	}));
	return { type: 'graph', nodes, edges: graph.edges, width: layout.width, height: layout.height };
}

export function graphPage(nonce: string): string {
	return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
	html, body { margin: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 12px; }
	svg { width: 100%; height: 100%; cursor: grab; display: block; }
	svg.dragging { cursor: grabbing; }
	.legend { position: absolute; top: 8px; left: 12px; display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--vscode-descriptionForeground); pointer-events: none; }
	.legend span { display: inline-flex; align-items: center; gap: 6px; }
	.legend i { display: inline-block; width: 18px; border-top: 2px solid var(--vscode-foreground); }
	.empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--vscode-descriptionForeground); }
	.empty[hidden] { display: none; }
	.node { cursor: pointer; }
	.node .card { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-editorWidget-border, var(--vscode-panel-border)); }
	.node:hover .card, .node:focus .card { stroke: var(--vscode-focusBorder); stroke-width: 2; }
	.node:focus { outline: none; }
	.title { fill: var(--vscode-foreground); font-size: 12px; }
	.meta { fill: var(--vscode-descriptionForeground); font-size: 11px; }
	.edge { fill: none; stroke: var(--vscode-descriptionForeground); stroke-opacity: 0.55; }
	.edge.step { stroke-width: 2; stroke-opacity: 0.85; }
	.edge.premise { stroke-dasharray: 6 4; }
	.edge.formal { stroke: var(--vscode-charts-purple); stroke-opacity: 0.8; }
	.edge.evidence { stroke: var(--vscode-testing-iconPassed); stroke-dasharray: 2 4; }
</style>
</head>
<body>
<div class="legend">
	<span><i></i>has step</span>
	<span><i style="border-top-style: dashed"></i>relies on</span>
	<span><i style="border-top-width: 1px; opacity: .6"></i>is about</span>
	<span><i style="border-top-color: var(--vscode-charts-purple)"></i>stated in Lean</span>
	<span><i style="border-top-style: dotted; border-top-color: var(--vscode-testing-iconPassed)"></i>checked by</span>
</div>
<svg id="graph" preserveAspectRatio="xMidYMin meet" role="img" aria-label="Prooftree knowledge graph"></svg>
<div class="empty" id="empty" hidden>No claims yet. Declare one from a selection to start the graph.</div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const svg = document.getElementById('graph');
	const NS = 'http://www.w3.org/2000/svg';
	const W = ${NODE_WIDTH}, H = ${NODE_HEIGHT}, PAD = 48;
	let view = null;

	function el(name, attrs, parent) {
		const node = document.createElementNS(NS, name);
		for (const [key, value] of Object.entries(attrs)) { node.setAttribute(key, value); }
		parent?.appendChild(node);
		return node;
	}
	function clip(text, max) { return text.length > max ? text.slice(0, max - 1) + '…' : text; }

	function render(graph) {
		svg.replaceChildren();
		document.getElementById('empty').hidden = graph.nodes.length > 0;
		const defs = el('defs', {}, svg);
		const marker = el('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' }, defs);
		el('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'var(--vscode-descriptionForeground)' }, marker);
		const byId = new Map(graph.nodes.map(node => [node.id, node]));
		const edges = el('g', {}, svg);
		for (const edge of graph.edges) {
			const a = byId.get(edge.from), b = byId.get(edge.to);
			if (!a || !b) { continue; }
			const down = b.y > a.y;
			const y1 = a.y + (down ? H / 2 : -H / 2), y2 = b.y + (down ? -H / 2 : H / 2);
			const mid = (y1 + y2) / 2;
			el('path', { class: 'edge ' + edge.kind, d: 'M' + a.x + ',' + y1 + ' C' + a.x + ',' + mid + ' ' + b.x + ',' + mid + ' ' + b.x + ',' + y2, 'marker-end': 'url(#arrow)' }, edges);
		}
		for (const node of graph.nodes) {
			const g = el('g', { class: 'node', transform: 'translate(' + (node.x - W / 2) + ',' + (node.y - H / 2) + ')', tabindex: 0, role: 'button' }, svg);
			const title = el('title', {}, g);
			title.textContent = node.kind === 'claim' ? node.id + ': ' + node.label + ' (' + node.statusLabel + ')' : node.label;
			const rect = el('rect', { class: 'card', width: W, height: H, rx: node.kind === 'check' ? H / 2 : 6 }, g);
			if (node.kind === 'file') { rect.setAttribute('stroke-dasharray', '4 3'); }
			if (node.kind === 'claim') {
				el('rect', { width: 5, height: H, rx: 2, style: 'fill: ' + node.color }, g);
				el('text', { class: 'title', x: 14, y: 22 }, g).textContent = clip(node.label, 32);
				el('text', { class: 'meta', x: 14, y: 40 }, g).textContent = node.statusLabel + ' · ' + node.id;
				el('circle', { cx: W - 14, cy: 14, r: 5, style: 'fill: ' + node.color }, g);
			} else {
				const kind = { file: 'file', lean: 'Lean', check: 'check' }[node.kind];
				el('text', { class: 'meta', x: 14, y: 20 }, g).textContent = kind;
				el('text', { class: 'title', x: 14, y: 38 }, g).textContent = clip(node.label, 32);
			}
			const open = () => vscode.postMessage({ type: 'open', id: node.id });
			g.addEventListener('click', open);
			g.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { open(); } });
		}
		if (!view) {
			view = { x: -PAD, y: -PAD - 32, w: Math.max(graph.width + 2 * PAD, 600), h: Math.max(graph.height + 2 * PAD + 32, 400) };
		}
		applyView();
	}

	function applyView() { svg.setAttribute('viewBox', [view.x, view.y, view.w, view.h].join(' ')); }

	svg.addEventListener('wheel', event => {
		if (!view) { return; }
		event.preventDefault();
		const factor = event.deltaY > 0 ? 1.1 : 1 / 1.1;
		const box = svg.getBoundingClientRect();
		const px = view.x + (event.clientX - box.left) / box.width * view.w;
		const py = view.y + (event.clientY - box.top) / box.height * view.h;
		view = { x: px - (px - view.x) * factor, y: py - (py - view.y) * factor, w: view.w * factor, h: view.h * factor };
		applyView();
	}, { passive: false });

	let drag = null;
	svg.addEventListener('pointerdown', event => {
		if (event.target.closest('.node') || !view) { return; }
		drag = { x: event.clientX, y: event.clientY, view: { ...view } };
		svg.classList.add('dragging');
		svg.setPointerCapture(event.pointerId);
	});
	svg.addEventListener('pointermove', event => {
		if (!drag) { return; }
		const box = svg.getBoundingClientRect();
		view = { ...drag.view, x: drag.view.x - (event.clientX - drag.x) / box.width * view.w, y: drag.view.y - (event.clientY - drag.y) / box.height * view.h };
		applyView();
	});
	svg.addEventListener('pointerup', () => { drag = null; svg.classList.remove('dragging'); });

	window.addEventListener('message', event => { if (event.data.type === 'graph') { render(event.data); } });
	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
