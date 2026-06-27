import type { LogicNode, GateNode, Diagram, DiagramOutput, PortMeta, RenderOptions } from '../parser/ast.js';

// A node in the flattened logic graph (the semantic model: gates, inputs, outputs and function
// blocks with their connectivity and depth), produced from the parsed AST before any geometry.
export interface FlatNode {
  id: string;
  kind: 'gate' | 'input' | 'output';
  gateType?: string;
  label?: string;
  name?: string;
  description?: string;
  depth: number;
  inputIds: string[];
  invertedInputs?: Set<number>;
  bubbledOutput?: boolean;
  blockType?: string;                 // SEL function block (TIMER/SR/RISING/FALLING/COMPARE)
  params?: Record<string, string>;    // block settings
  usedPorts?: Set<string>;            // output ports referenced (e.g. SR Q / NQ)
  inputPorts?: (string | undefined)[]; // per-input source output-port name (for multi-output sources)
  inputLabels?: (string | undefined)[]; // per-input port label (FB named inputs)
}

// A net label for a consumed intermediate signal — drawn later at its driver's fan-out junction.
export interface IntermediateLabel {
  driverId: string;
  port?: string;
  name?: string;
  description?: string;
}

export interface Graph {
  nodes: Map<string, FlatNode>;
  intermediateLabels: IntermediateLabel[];
}

// Flatten the AST: associative AND/OR chains are merged into single multi-input gates; blocks and
// leaves pass through. (NOT stays a gate here; BUBBLES absorption happens in buildGraph.)
export function flattenGate(node: LogicNode): LogicNode {
  if (node.kind === 'port') return node;
  if (node.kind === 'symbolRef') return node;
  if (node.kind === 'block') return { ...node, inputs: node.inputs.map(flattenGate) };
  if (node.kind !== 'gate') return node;

  const flatInputs = node.inputs.map(flattenGate);

  if (node.gateType === 'AND' || node.gateType === 'OR') {
    const merged: LogicNode[] = [];
    for (const input of flatInputs) {
      if (input.kind === 'gate' && input.gateType === node.gateType) {
        merged.push(...input.inputs);
      } else {
        merged.push(input);
      }
    }
    return { kind: 'gate', gateType: node.gateType, inputs: merged } as GateNode;
  }

  return { kind: 'gate', gateType: node.gateType, inputs: flatInputs } as GateNode;
}

// Build the flattened logic graph from the parsed diagram: resolve every assignment into shared
// signal nodes (consumed intermediates fan out instead of duplicating), apply BUBBLES inversion
// absorption, and assign depths. Pure with respect to geometry — only the semantic model.
export function buildGraph(
  diagram: Diagram,
  portMeta: PortMeta[],
  opts: RenderOptions,
  uid: (prefix: string) => string,
): Graph {
  const flatOutputs: DiagramOutput[] = diagram.outputs.map(o => ({
    ...o,
    expression: flattenGate(o.expression),
  }));

  const metaMap = new Map<string, { name?: string; description?: string }>();
  for (const m of portMeta) {
    let e = metaMap.get(m.identifier);
    if (!e) { e = {}; metaMap.set(m.identifier, e); }
    if (m.property === 'Name') e.name = m.value;
    if (m.property === 'Description') e.description = m.value;
  }

  const nodes = new Map<string, FlatNode>();
  const inputMap = new Map<string, string>();
  const exprMap = new Map<string, string>();
  const blockMap = new Map<string, string>(); // function-block instances (dedup by id/structure)
  const nameDriver = new Map<string, string>();        // intermediate name -> resolved driver node id
  const nameDriverPort = new Map<string, string | undefined>(); // its output port selector (e.g. NQ)

  // Default output port of a function block when none is selected (SR exposes Q/NQ).
  const defaultPort = (blockType: string) => (blockType === 'SR' ? 'Q' : 'OUT');
  // The source output-port name a child reference points at (block .Q/.NQ, symbol port, or the
  // selector carried by a referenced intermediate signal).
  const portOf = (child: LogicNode): string | undefined =>
    child.kind === 'block' ? (child.port ?? defaultPort(child.blockType)).toUpperCase()
      : child.kind === 'symbolRef' ? child.portName
      : child.kind === 'port' && nameDriverPort.has(child.name) ? nameDriverPort.get(child.name)
      : undefined;

  const outputMeta = new Map<string, { name?: string; description?: string }>();
  for (const m of portMeta) {
    let e = outputMeta.get(m.identifier);
    if (!e) { e = {}; outputMeta.set(m.identifier, e); }
    if (m.property === 'Name') e.name = m.value;
    if (m.property === 'Description') e.description = m.value;
  }

  // Each LHS name defines a signal. A name referenced inside ANOTHER name's expression is a
  // CONSUMED intermediate: it is not drawn as an output — its driver fans out to the consumers —
  // unless it has no consumer (a sink), references itself (feedback/seal-in), or is forced with
  // `NAME.OUT = TRUE`.
  const definitionExpr = new Map<string, LogicNode>();
  for (const o of flatOutputs) if (!definitionExpr.has(o.name)) definitionExpr.set(o.name, o.expression);

  const consumedByOther = new Set<string>();
  const selfRef = new Set<string>();
  const scanRefs = (owner: string, n: LogicNode): void => {
    if (n.kind === 'port') {
      if (definitionExpr.has(n.name)) (n.name === owner ? selfRef : consumedByOther).add(n.name);
    } else if (n.kind === 'gate' || n.kind === 'block') {
      for (const c of n.inputs) scanRefs(owner, c);
    }
  };
  for (const o of flatOutputs) scanRefs(o.name, o.expression);

  const forceOut = new Set<string>();
  for (const m of portMeta) if (m.property === 'Out' && /^(true|1|yes|on)$/i.test(m.value.trim())) forceOut.add(m.identifier);

  const isShownOutput = (name: string) => !consumedByOther.has(name) || forceOut.has(name) || selfRef.has(name);

  // Output nodes exist only for SHOWN names (sinks, feedback, or forced). A consumed intermediate
  // resolves to its driver wherever referenced, so its signal is shared instead of duplicated.
  const outputIdByName = new Map<string, string>();
  for (const output of flatOutputs) {
    if (outputIdByName.has(output.name) || !isShownOutput(output.name)) continue;
    const outputId = uid('out');
    const meta = outputMeta.get(output.name);
    nodes.set(outputId, {
      id: outputId, kind: 'output', label: output.name,
      name: meta?.name, description: meta?.description, depth: 0, inputIds: [],
    });
    outputIdByName.set(output.name, outputId);
  }

  const resolvingNames = new Set<string>();
  function makeInput(name: string): string {
    if (!inputMap.has(name)) {
      const id = uid('in');
      const meta = metaMap.get(name);
      nodes.set(id, { id, kind: 'input', label: name, name: meta?.name, description: meta?.description, depth: 0, inputIds: [] });
      inputMap.set(name, id);
    }
    return inputMap.get(name)!;
  }
  // Resolve a defined name to its driver node, memoised. A name referenced while it is itself
  // being resolved is a cycle → loop back to its output node (feedback), or an input if unshown.
  function resolveName(name: string): string {
    if (nameDriver.has(name)) return nameDriver.get(name)!;
    if (resolvingNames.has(name)) return outputIdByName.get(name) ?? makeInput(name);
    resolvingNames.add(name);
    const driver = resolve(definitionExpr.get(name)!);
    resolvingNames.delete(name);
    nameDriver.set(name, driver);
    nameDriverPort.set(name, portOf(definitionExpr.get(name)!));
    return driver;
  }

  function resolve(node: LogicNode): string {
    if (node.kind === 'port') {
      if (definitionExpr.has(node.name)) return resolveName(node.name); // shared intermediate/output
      return makeInput(node.name);
    }
    if (node.kind === 'symbolRef') {
      const id = uid('sym');
      nodes.set(id, {
        id, kind: 'gate', gateType: node.symbolName,
        depth: 0, inputIds: [],
      });
      return id;
    }
    if (node.kind === 'gate') {
      const inputIds = node.inputs.map(i => resolve(i));
      const inputPorts = node.inputs.map(portOf);
      // Canonical key for deduplication: sort inputs for commutative operators.
      // A gate with an explicit instance id (AND#MYID) is NEVER deduplicated — each id is
      // a distinct instance. The id is also the key for .Name / .Description meta lookup.
      const keyInputIds = (node.gateType === 'AND' || node.gateType === 'OR')
        ? [...inputIds].sort()
        : inputIds;
      const key = node.id ? `G#${node.id}` : `${node.gateType}(${keyInputIds.join(',')})`;
      const existing = exprMap.get(key);
      if (existing) return existing;

      const id = uid(node.gateType.toLowerCase());
      // Feedback inputs (an output node) do NOT contribute depth — the back-edge would
      // otherwise create a cycle / push the gate to the far right.
      const depth = Math.max(...inputIds.map(iid => {
        const n = nodes.get(iid);
        return n && n.kind === 'output' ? 0 : n?.depth ?? 0;
      }), 0) + 1;
      const meta = node.id ? metaMap.get(node.id) : undefined;
      nodes.set(id, {
        id, kind: 'gate', gateType: node.gateType,
        label: node.id, name: meta?.name, description: meta?.description,
        depth, inputIds, inputPorts,
      });
      exprMap.set(key, id);
      return id;
    }
    if (node.kind === 'block') {
      const inputIds = node.inputs.map(i => resolve(i));
      const key = node.id
        ? `B#${node.id}`
        : `B:${node.blockType}(${inputIds.join(',')};${JSON.stringify(node.params)})`;
      let id = blockMap.get(key);
      if (!id) {
        const inputPorts = node.inputs.map(portOf);
        const depth = Math.max(...inputIds.map(iid => {
          const n = nodes.get(iid);
          return n && n.kind === 'output' ? 0 : n?.depth ?? 0;
        }), 0) + 1;
        const meta = node.id ? metaMap.get(node.id) : undefined;
        id = uid(node.blockType.toLowerCase());
        nodes.set(id, {
          id, kind: 'gate', gateType: node.blockType, blockType: node.blockType,
          params: node.params, name: meta?.name, description: meta?.description,
          depth, inputIds, inputPorts, inputLabels: node.inputLabels, usedPorts: new Set<string>(),
        });
        blockMap.set(key, id);
      }
      nodes.get(id)!.usedPorts!.add((node.port ?? defaultPort(node.blockType)).toUpperCase());
      return id;
    }
    return uid('unknown');
  }

  for (const output of flatOutputs) {
    const outputId = outputIdByName.get(output.name);
    if (!outputId) continue; // consumed intermediate — not drawn, only its driver is shared
    const driver = resolveName(output.name);
    const on = nodes.get(outputId)!;
    on.inputIds = [driver];
    on.inputPorts = [portOf(output.expression)];
    on.depth = (nodes.get(driver)?.depth ?? 0) + 1;
  }

  // A consumed intermediate (not drawn as an output) can still be labelled at its fan-out
  // junction by setting NAME.Name / NAME.Description — a net label on the shared signal.
  const intermediateLabels: IntermediateLabel[] = [];
  for (const [name, driverId] of nameDriver) {
    if (isShownOutput(name)) continue; // shown signals are labelled at their output node
    const meta = metaMap.get(name);
    if (meta && (meta.name || meta.description)) {
      intermediateLabels.push({ driverId, port: nameDriverPort.get(name), name: meta.name ?? name, description: meta.description });
    }
  }

  // INVERSION = BUBBLES: absorb NOT gates into downstream ports with inversion bubbles
  if (opts.inversion === 'BUBBLES') {
    const notNodes = Array.from(nodes.values())
      .filter(n => n.kind === 'gate' && n.gateType === 'NOT');

    // Build NOT chain info: for each NOT, walk to the ultimate non-NOT source
    // and record the cumulative inversion depth.
    const notChainInfo = new Map<string, { sourceId: string; inversionDepth: number }>();

    for (const notNode of notNodes) {
      if (notNode.inputIds.length !== 1) continue;
      let sourceId = notNode.inputIds[0];
      let depth = 1;

      while (true) {
        const sourceNode = nodes.get(sourceId);
        if (sourceNode && sourceNode.kind === 'gate' && sourceNode.gateType === 'NOT' && sourceNode.inputIds.length === 1) {
          depth++;
          sourceId = sourceNode.inputIds[0];
        } else {
          break;
        }
      }

      notChainInfo.set(notNode.id, { sourceId, inversionDepth: depth });
    }

    // For each non-NOT node, walk each input through NOT chains to find
    // the ultimate source. Track inversion depth per input for bubble marking.
    const inputInversionDepth = new Map<string, Map<number, number>>();

    for (const otherNode of nodes.values()) {
      if (otherNode.kind === 'gate' && otherNode.gateType === 'NOT') continue;

      for (let i = 0; i < otherNode.inputIds.length; i++) {
        let ref = otherNode.inputIds[i];
        let totalInversion = 0;

        while (notChainInfo.has(ref)) {
          totalInversion += notChainInfo.get(ref)!.inversionDepth;
          otherNode.inputIds[i] = notChainInfo.get(ref)!.sourceId;
          ref = notChainInfo.get(ref)!.sourceId;
        }

        if (totalInversion > 0) {
          if (!inputInversionDepth.has(otherNode.id)) {
            inputInversionDepth.set(otherNode.id, new Map());
          }
          inputInversionDepth.get(otherNode.id)!.set(i, totalInversion);
        }
      }
    }

    // Mark bubbled inputs/outputs based on inversion depth
    // Odd inversion → bubble; even → cancel out
    for (const [nodeId, depthMap] of inputInversionDepth) {
      const node = nodes.get(nodeId);
      if (!node) continue;

      for (const [inputIdx, depth] of depthMap) {
        if (depth % 2 === 1) {
          const sourceId = node.inputIds[inputIdx];
          const sourceNode = nodes.get(sourceId);

          if (sourceNode && sourceNode.kind === 'gate' && sourceNode.gateType !== 'NOT') {
            // Source is a gate: output-side bubble on the source gate
            sourceNode.bubbledOutput = true;
          } else {
            // Source is an input port or output node: input-side bubble on this node
            if (!node.invertedInputs) node.invertedInputs = new Set();
            node.invertedInputs.add(inputIdx);
          }
        }
        // Even inversion: both NOTs cancel, no bubble needed
      }
    }

    // Remove all NOT nodes
    for (const n of notNodes) {
      nodes.delete(n.id);
    }

    // Recalculate depths after removing NOTs — nodes may have shallower depths now
    const depthOrder = Array.from(nodes.values()).sort((a, b) => a.depth - b.depth);
    for (const node of depthOrder) {
      if (node.kind === 'input') {
        node.depth = 0;
      } else {
        const inputDepths = node.inputIds
          .map(id => nodes.get(id)?.depth ?? 0);
        node.depth = (inputDepths.length > 0 ? Math.max(...inputDepths) : 0) + 1;
      }
    }

    // Compress depth values to remove gaps
    const usedDepths = [...new Set(Array.from(nodes.values()).map(n => n.depth))].sort((a, b) => a - b);
    const depthRemap = new Map<number, number>();
    usedDepths.forEach((d, i) => depthRemap.set(d, i));
    for (const node of nodes.values()) {
      node.depth = depthRemap.get(node.depth) ?? node.depth;
    }
  }

  // Push outputs to a higher depth if they share a column with any gate node.
  // This prevents wires from passing through intermediate gate bodies when an
  // output's depth column coincides with a gate's (e.g. when a shared subexpression
  // feeds both a multi-input gate and a direct output).
  {
    const maxCheckDepth = Math.max(...Array.from(nodes.values()).map(n => n.depth), 0) + 5;
    for (let depth = 0; depth <= maxCheckDepth; depth++) {
      const hasGate = Array.from(nodes.values()).some(n => n.kind === 'gate' && n.depth === depth);
      if (!hasGate) continue;
      for (const node of nodes.values()) {
        if (node.kind === 'output' && node.depth === depth) {
          node.depth++;
        }
      }
    }
  }

  return { nodes, intermediateLabels };
}
