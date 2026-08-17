import { describe, it, expect } from 'vitest';
import { renderPlanTree, type PlanStepStatus } from '../../src/utils/display.js';
import type { TaskPlan } from '../../src/core/pipeline/types.js';

function makePlan(descriptions: string[]): TaskPlan {
  return {
    goal: 'Ship the feature',
    reasoning: 'test plan',
    steps: descriptions.map((d, i) => ({
      id: i + 1,
      description: d,
      toolsHint: [],
      expectedOutcome: 'done',
      verification: 'no errors',
    })),
  };
}

// Strip ANSI escape codes so assertions can check plain text content
// regardless of whether chalk is emitting color codes in this environment.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('renderPlanTree', () => {
  it('includes the plan goal and step count in the header line', () => {
    const plan = makePlan(['Step A', 'Step B']);
    const statuses: PlanStepStatus[] = ['pending', 'pending'];
    const output = stripAnsi(renderPlanTree(plan, statuses));
    expect(output).toContain('Ship the feature');
    expect(output).toContain('(2 steps)');
  });

  it('renders one line per step, each containing its description', () => {
    const plan = makePlan(['Read the config', 'Write the output']);
    const statuses: PlanStepStatus[] = ['pending', 'pending'];
    const output = stripAnsi(renderPlanTree(plan, statuses));
    expect(output).toContain('Read the config');
    expect(output).toContain('Write the output');
  });

  it('uses the last-item branch connector (└─) only for the final step', () => {
    const plan = makePlan(['First', 'Second', 'Third']);
    const statuses: PlanStepStatus[] = ['pending', 'pending', 'pending'];
    const lines = stripAnsi(renderPlanTree(plan, statuses)).split('\n');
    expect(lines[1]).toContain('├─');
    expect(lines[2]).toContain('├─');
    expect(lines[3]).toContain('└─');
  });

  it('marks a done step with the ✓ icon', () => {
    const plan = makePlan(['Only step']);
    const statuses: PlanStepStatus[] = ['done'];
    const output = stripAnsi(renderPlanTree(plan, statuses));
    expect(output).toContain('✓');
  });

  it('marks a failed step with the ✗ icon', () => {
    const plan = makePlan(['Only step']);
    const statuses: PlanStepStatus[] = ['failed'];
    const output = stripAnsi(renderPlanTree(plan, statuses));
    expect(output).toContain('✗');
  });

  it('marks an in-progress step with the → icon', () => {
    const plan = makePlan(['Only step']);
    const statuses: PlanStepStatus[] = ['in_progress'];
    const output = stripAnsi(renderPlanTree(plan, statuses));
    expect(output).toContain('→');
  });

  it('renders a mixed-status plan with each step showing its own icon', () => {
    const plan = makePlan(['Done step', 'Running step', 'Waiting step', 'Failed step']);
    const statuses: PlanStepStatus[] = ['done', 'in_progress', 'pending', 'failed'];
    const lines = stripAnsi(renderPlanTree(plan, statuses)).split('\n');
    // lines[0] is the header; steps start at lines[1]
    expect(lines[1]).toContain('✓');
    expect(lines[1]).toContain('Done step');
    expect(lines[2]).toContain('→');
    expect(lines[2]).toContain('Running step');
    expect(lines[3]).toContain('Waiting step');
    expect(lines[4]).toContain('✗');
    expect(lines[4]).toContain('Failed step');
  });

  it('defaults an unspecified status (array shorter than steps) to pending, without throwing', () => {
    const plan = makePlan(['A', 'B']);
    const statuses: PlanStepStatus[] = ['done']; // missing entry for step B
    expect(() => renderPlanTree(plan, statuses)).not.toThrow();
    const output = stripAnsi(renderPlanTree(plan, statuses));
    expect(output).toContain('B');
  });

  it('handles a single-step plan without a branch connector mismatch', () => {
    const plan = makePlan(['Solo step']);
    const statuses: PlanStepStatus[] = ['pending'];
    const lines = stripAnsi(renderPlanTree(plan, statuses)).split('\n');
    expect(lines).toHaveLength(2); // header + 1 step
    expect(lines[1]).toContain('└─');
  });
});
