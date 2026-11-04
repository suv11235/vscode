/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { STATUS_LABEL } from './format';
import { ClaimReport, ClaimStatus } from './status';

/**
 * The workspace's knowledge graph: claims, the files and Lean declarations they are about,
 * and the checks that discharged them, joined by step, premise, anchor and evidence edges.
 */

export type GraphNodeKind = 'claim' | 'file' | 'lean' | 'check';
export type GraphEdgeKind = 'step' | 'premise' | 'anchor' | 'formal' | 'evidence';

export interface GraphNode {
	readonly id: string;
	readonly kind: GraphNodeKind;
	readonly label: string;
	readonly status?: ClaimStatus;
	/** File to open for this node, with the 1-based line to reveal. */
	readonly file?: string;
	readonly line?: number;
}

export interface GraphEdge {
	readonly from: string;
	readonly to: string;
	readonly kind: GraphEdgeKind;
}

export interface KnowledgeGraph {
	readonly nodes: readonly GraphNode[];
	readonly edges: readonly GraphEdge[];
}

export interface PlacedNode extends GraphNode {
	readonly x: number;
	readonly y: number;
	readonly layer: number;
}

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 54;
const GAP_X = 36;
const GAP_Y = 96;

export function buildGraph(reports: ReadonlyMap<string, ClaimReport>): KnowledgeGraph {
	const nodes = new Map<string, GraphNode>();
	const edges: GraphEdge[] = [];
	const add = (node: GraphNode) => {
		if (!nodes.has(node.id)) {
			nodes.set(node.id, node);
		}
	};

	for (const report of reports.values()) {
		const { claim } = report;
		const firstAnchor = report.anchors.find(anchor => anchor.anchor.role !== 'formal' && anchor.kind !== 'missing');
		add({ id: claim.id, kind: 'claim', label: claim.statement, status: report.status, file: firstAnchor?.anchor.file, line: firstAnchor?.startLine });
	}
	for (const report of reports.values()) {
		const { claim } = report;
		for (const step of report.steps) {
			if (nodes.has(step)) {
				edges.push({ from: claim.id, to: step, kind: 'step' });
			}
		}
		for (const premise of claim.dependsOn) {
			if (nodes.has(premise)) {
				edges.push({ from: claim.id, to: premise, kind: 'premise' });
			}
		}
		const files = new Set<string>();
		for (const anchor of report.anchors) {
			if (anchor.anchor.role === 'formal' && claim.formal) {
				const id = `lean:${claim.formal.file}#${claim.formal.declaration}`;
				add({ id, kind: 'lean', label: claim.formal.declaration, file: claim.formal.file, line: anchor.startLine });
				edges.push({ from: claim.id, to: id, kind: 'formal' });
			} else if (!files.has(anchor.anchor.file)) {
				files.add(anchor.anchor.file);
				const id = `file:${anchor.anchor.file}`;
				add({ id, kind: 'file', label: anchor.anchor.file, file: anchor.anchor.file });
				edges.push({ from: claim.id, to: id, kind: 'anchor' });
			}
		}
		if (report.check?.check) {
			const id = `check:${report.check.check}`;
			add({ id, kind: 'check', label: report.check.check });
			edges.push({ from: claim.id, to: id, kind: 'evidence' });
		}
	}
	return { nodes: [...nodes.values()], edges };
}

/**
 * Layered layout: goals above their steps, claims above their premises, and files, Lean
 * declarations and checks on the bottom row. Rows are ordered to keep edges short.
 */
export function layoutGraph(graph: KnowledgeGraph): { nodes: PlacedNode[]; width: number; height: number } {
	const incoming = new Map<string, string[]>();
	for (const edge of graph.edges) {
		incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
	}
	const layers = new Map<string, number>();
	const visiting = new Set<string>();
	const layerOf = (id: string): number => {
		const known = layers.get(id);
		if (known !== undefined) {
			return known;
		}
		if (visiting.has(id)) {
			return 0;
		}
		visiting.add(id);
		const layer = Math.max(-1, ...(incoming.get(id) ?? []).map(layerOf)) + 1;
		visiting.delete(id);
		layers.set(id, layer);
		return layer;
	};
	const claims = graph.nodes.filter(node => node.kind === 'claim');
	const bottom = Math.max(-1, ...claims.map(node => layerOf(node.id))) + 1;
	for (const node of graph.nodes) {
		if (node.kind !== 'claim') {
			layers.set(node.id, bottom);
		}
	}

	const rows: GraphNode[][] = [];
	for (const node of graph.nodes) {
		const layer = layers.get(node.id)!;
		(rows[layer] ??= []).push(node);
	}
	// Order each row by the average position of the nodes pointing at it.
	const index = new Map<string, number>();
	const reindex = () => rows.forEach(row => row?.forEach((node, i) => index.set(node.id, i)));
	reindex();
	for (let sweep = 0; sweep < 4; sweep++) {
		for (const row of rows.slice(1)) {
			if (!row) {
				continue;
			}
			const weight = (node: GraphNode) => {
				const parents = (incoming.get(node.id) ?? []).map(id => index.get(id)!).filter(i => i !== undefined);
				return parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : index.get(node.id)!;
			};
			row.sort((a, b) => weight(a) - weight(b));
			reindex();
		}
	}

	const widest = Math.max(1, ...rows.map(row => row?.length ?? 0));
	const width = widest * (NODE_WIDTH + GAP_X) - GAP_X;
	const placed: PlacedNode[] = [];
	rows.forEach((row, layer) => {
		const rowWidth = row.length * (NODE_WIDTH + GAP_X) - GAP_X;
		row.forEach((node, i) => placed.push({
			...node,
			layer,
			x: (width - rowWidth) / 2 + i * (NODE_WIDTH + GAP_X) + NODE_WIDTH / 2,
			y: layer * (NODE_HEIGHT + GAP_Y) + NODE_HEIGHT / 2,
		}));
	});
	return { nodes: placed, width, height: rows.length * (NODE_HEIGHT + GAP_Y) - GAP_Y };
}

/** Finds a node by claim id, file path, Lean declaration or check name. */
export function findNode(graph: KnowledgeGraph, focus: string): GraphNode | undefined {
	return graph.nodes.find(node => node.id === focus)
		?? graph.nodes.find(node => node.id === `file:${focus}` || node.id === `check:${focus}`)
		?? graph.nodes.find(node => node.kind === 'lean' && (node.label === focus || node.label.endsWith(`.${focus}`)));
}

/** Nodes within `radius` edges of `focus`, in either direction, and the edges between them. */
export function neighborhood(graph: KnowledgeGraph, focus: string, radius: number): KnowledgeGraph {
	const reached = new Set([focus]);
	let frontier = [focus];
	for (let step = 0; step < radius; step++) {
		const next: string[] = [];
		for (const edge of graph.edges) {
			for (const [here, there] of [[edge.from, edge.to], [edge.to, edge.from]]) {
				if (frontier.includes(here) && !reached.has(there)) {
					reached.add(there);
					next.push(there);
				}
			}
		}
		frontier = next;
	}
	return {
		nodes: graph.nodes.filter(node => reached.has(node.id)),
		edges: graph.edges.filter(edge => reached.has(edge.from) && reached.has(edge.to)),
	};
}

const EDGE_TEXT: Readonly<Record<GraphEdgeKind, string>> = {
	step: 'has step',
	premise: 'relies on',
	anchor: 'is about',
	formal: 'is stated in Lean as',
	evidence: 'was checked by',
};

function nodeText(node: GraphNode | undefined, id: string): string {
	if (!node) {
		return id;
	}
	switch (node.kind) {
		case 'claim': return `${node.id} "${node.label}" [${STATUS_LABEL[node.status!]}]`;
		case 'file': return `file ${node.label}`;
		case 'lean': return `Lean ${node.label} (${node.file})`;
		case 'check': return `check ${node.label}`;
	}
}

/** The graph as one line per edge, for agents. */
export function describeGraph(graph: KnowledgeGraph): string {
	if (!graph.nodes.length) {
		return 'The knowledge graph is empty.';
	}
	const byId = new Map(graph.nodes.map(node => [node.id, node]));
	const linked = new Set(graph.edges.flatMap(edge => [edge.from, edge.to]));
	const lines = graph.edges.map(edge => `${nodeText(byId.get(edge.from), edge.from)} ${EDGE_TEXT[edge.kind]} ${nodeText(byId.get(edge.to), edge.to)}`);
	for (const node of graph.nodes) {
		if (!linked.has(node.id)) {
			lines.push(nodeText(node, node.id));
		}
	}
	return `${graph.nodes.length} nodes, ${graph.edges.length} edges:\n` + lines.join('\n');
}
