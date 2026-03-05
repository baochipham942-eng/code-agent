// ============================================================================
// Trajectory Visualizer - Multiple output formats for trajectory data
// ============================================================================

import type {
  Trajectory,
  TrajectoryStep,
  DeviationMarker,
} from '../../testing/types';

interface VisualizationNode {
  id: string;
  type: string;
  label: string;
  status: string;
  duration: number;
}

interface VisualizationEdge {
  from: string;
  to: string;
  type: string;
}

interface VisualizationJson {
  nodes: VisualizationNode[];
  edges: VisualizationEdge[];
  deviations: DeviationMarker[];
}

/**
 * Renders a Trajectory into various visual formats:
 * - Mermaid sequence diagram
 * - Console-friendly timeline
 * - JSON graph data for frontend rendering
 */
export class TrajectoryVisualizer {
  toMermaidSequenceDiagram(trajectory: Trajectory): string {
    const lines: string[] = [];
    lines.push('sequenceDiagram');
    lines.push('    participant Agent');
    lines.push('    participant Tools');
    lines.push('');

    const deviationSteps = new Set(trajectory.deviations.map(d => d.stepIndex));

    for (const step of trajectory.steps) {
      switch (step.type) {
        case 'tool_call': {
          if (!step.toolCall) break;
          const argsPreview = this.truncate(this.formatArgs(step.toolCall.args), 40);
          const label = `${step.toolCall.name}(${argsPreview})`;

          lines.push(`    Agent->>Tools: ${this.escapeMermaid(label)}`);

          if (step.toolCall.success) {
            const resultPreview = step.toolCall.result
              ? this.truncate(step.toolCall.result, 30)
              : 'ok';
            lines.push(`    Tools-->>Agent: ${this.escapeMermaid(resultPreview)}`);
          } else {
            lines.push(`    Tools--xAgent: FAILED`);
          }

          if (deviationSteps.has(step.index)) {
            const dev = trajectory.deviations.find(d => d.stepIndex === step.index);
            if (dev) {
              lines.push(`    Note right of Tools: ⚠ ${this.escapeMermaid(dev.type)}`);
            }
          }
          break;
        }

        case 'error': {
          const errMsg = step.error?.message ?? 'unknown error';
          lines.push(`    Note over Agent,Tools: ERROR: ${this.escapeMermaid(this.truncate(errMsg, 40))}`);
          break;
        }

        case 'decision': {
          const reason = step.decision?.reasoning ?? '';
          lines.push(`    Note left of Agent: ${this.escapeMermaid(this.truncate(reason, 40))}`);
          break;
        }

        case 'recovery': {
          lines.push(`    Note over Agent: Recovery attempt`);
          break;
        }

        default:
          break;
      }
    }

    return lines.join('\n');
  }

  toConsoleTimeline(trajectory: Trajectory): string {
    const lines: string[] = [];
    const deviationMap = new Map<number, DeviationMarker>();
    for (const d of trajectory.deviations) {
      deviationMap.set(d.stepIndex, d);
    }

    // Header
    lines.push(`=== Trajectory: ${trajectory.id} ===`);
    lines.push(`  Outcome: ${trajectory.summary.outcome}`);
    lines.push(`  Steps: ${trajectory.steps.length} | Efficiency: ${(trajectory.efficiency.efficiency * 100).toFixed(1)}%`);
    lines.push(`  Duration: ${trajectory.efficiency.totalDuration}ms`);
    lines.push('');
    lines.push('  Timeline:');
    lines.push('  ' + '-'.repeat(60));

    const baseTime = trajectory.startTime;

    for (const step of trajectory.steps) {
      const relTime = step.timestamp - baseTime;
      const timeStr = this.formatDuration(relTime).padStart(8);
      const deviation = deviationMap.get(step.index);
      const devFlag = deviation ? ` [!${deviation.type}]` : '';

      switch (step.type) {
        case 'tool_call': {
          if (!step.toolCall) break;
          const status = step.toolCall.success ? '+' : 'x';
          const dur = step.toolCall.duration > 0 ? ` (${step.toolCall.duration}ms)` : '';
          lines.push(`  ${timeStr} [${status}] ${step.toolCall.name}${dur}${devFlag}`);
          break;
        }
        case 'error': {
          const msg = this.truncate(step.error?.message ?? 'error', 50);
          lines.push(`  ${timeStr} [E] ${msg}${devFlag}`);
          break;
        }
        case 'decision': {
          const reason = this.truncate(step.decision?.reasoning ?? '', 50);
          lines.push(`  ${timeStr} [?] ${reason}${devFlag}`);
          break;
        }
        case 'recovery': {
          lines.push(`  ${timeStr} [R] Recovery attempt${devFlag}`);
          break;
        }
        default: {
          lines.push(`  ${timeStr} [.] ${step.type}${devFlag}`);
          break;
        }
      }
    }

    // Recovery patterns
    if (trajectory.recoveryPatterns.length > 0) {
      lines.push('');
      lines.push('  Recovery Patterns:');
      for (const rp of trajectory.recoveryPatterns) {
        const status = rp.successful ? 'SUCCESS' : 'FAILED';
        lines.push(
          `    Step ${rp.errorStepIndex} -> ${rp.recoveryStepIndex}: ` +
          `${rp.strategy} (${rp.attempts} attempts) [${status}]`
        );
      }
    }

    // Deviations
    if (trajectory.deviations.length > 0) {
      lines.push('');
      lines.push('  Deviations:');
      for (const d of trajectory.deviations) {
        lines.push(`    Step ${d.stepIndex} [${d.severity}] ${d.type}: ${d.description}`);
      }
    }

    return lines.join('\n');
  }

  toVisualizationJson(trajectory: Trajectory): VisualizationJson {
    const nodes: VisualizationNode[] = [];
    const edges: VisualizationEdge[] = [];

    for (const step of trajectory.steps) {
      const node = this.stepToNode(step);
      nodes.push(node);
    }

    // Create edges between consecutive steps
    for (let i = 0; i < nodes.length - 1; i++) {
      const edgeType = this.inferEdgeType(trajectory.steps[i], trajectory.steps[i + 1]);
      edges.push({
        from: nodes[i].id,
        to: nodes[i + 1].id,
        type: edgeType,
      });
    }

    // Add recovery edges
    for (const rp of trajectory.recoveryPatterns) {
      edges.push({
        from: `step_${rp.errorStepIndex}`,
        to: `step_${rp.recoveryStepIndex}`,
        type: 'recovery',
      });
    }

    return {
      nodes,
      edges,
      deviations: trajectory.deviations,
    };
  }

  // ---- Helpers ----

  private stepToNode(step: TrajectoryStep): VisualizationNode {
    let label: string;
    let status: string;
    let duration = 0;

    switch (step.type) {
      case 'tool_call':
        label = step.toolCall?.name ?? 'unknown';
        status = step.toolCall?.success ? 'success' : 'failure';
        duration = step.toolCall?.duration ?? 0;
        break;
      case 'error':
        label = this.truncate(step.error?.message ?? 'error', 30);
        status = 'error';
        break;
      case 'decision':
        label = this.truncate(step.decision?.reasoning ?? 'thinking', 30);
        status = 'info';
        break;
      case 'recovery':
        label = step.recovery?.strategy ?? 'recovery';
        status = step.recovery?.successful ? 'success' : 'failure';
        break;
      default:
        label = step.type;
        status = 'info';
    }

    return {
      id: `step_${step.index}`,
      type: step.type,
      label,
      status,
      duration,
    };
  }

  private inferEdgeType(from: TrajectoryStep, to: TrajectoryStep): string {
    if (from.type === 'error' && to.type === 'tool_call') return 'recovery';
    if (from.type === 'tool_call' && !from.toolCall?.success && to.type === 'tool_call') return 'retry';
    return 'sequential';
  }

  private formatArgs(args: Record<string, unknown>): string {
    const keys = Object.keys(args);
    if (keys.length === 0) return '';
    if (keys.length === 1) {
      const val = String(args[keys[0]] ?? '');
      return val.length <= 40 ? val : val.slice(0, 37) + '...';
    }
    return keys.join(', ');
  }

  private truncate(s: string, maxLen: number): string {
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen - 3) + '...';
  }

  private escapeMermaid(s: string): string {
    // Mermaid does not allow certain characters in labels
    return s.replace(/[#;{}]/g, '_').replace(/\n/g, ' ');
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  }
}
