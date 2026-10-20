/** Reporting guidance only: profiles share the same graph and feed format. */
export const reasoningProfiles = {
  investigation: {
    label: 'Investigation',
    summary: 'Candidate causes, discriminating tests, evidence, and a conclusion.',
    instructions:
      'Organize the problem into candidate causes, discriminating tests, observations, and a conclusion. Put reproduction conditions and success criteria on the goal or question. Keep observed facts separate from hypotheses; attach sources to evidence and test results. Update hypotheses when tests contradict them. Keep it to the causes actually in play: about three levels and twenty notes, then offer to expand a branch on request. Preserve rejected hypotheses and the evidence against them — leave out redundancy, never findings.',
  },
  architecture: {
    label: 'Architecture',
    summary: 'Design options compared against explicit criteria, ending in a decision.',
    instructions:
      'Start with requirements and constraints in the goal or question criteria. Represent candidate designs as option nodes under the same parent, including the current design when relevant. Use proposed or rejected status for options. Evaluate each option against explicit criteria such as reliability, latency, cost, operational complexity, and reversibility; populate evaluations with the exact criterion names and textual assessments for the comparison view. Record broader tradeoffs in detail and benchmark outcomes in experiment results. Record the chosen option, rationale, and remaining risks in a decision node. Option suitability is not hypothesis confidence; do not assign confidence percentages to options. Use hypotheses only for testable claims about a design. Keep it to the options actually under consideration: about three levels and twenty-five notes, then offer to expand a branch on request. Record a tradeoff in the detail or evaluations of the option rather than as a separate child note.',
  },
  research: {
    label: 'Research',
    summary: 'A research question, hypotheses, experiments, and sourced results.',
    instructions:
      'State the research question, scope, and evaluation criteria. Separate hypotheses, planned experiments, observations, and conclusions. Attach sources for papers, datasets, code, and result artifacts; cite only sources actually consulted. In experiment detail record methods, conditions, and reproduction steps; in result record measurements, units, sample sizes, limitations, and measured uncertainty when available. Distinguish reported literature findings from your own observations. Hypothesis confidence is a subjective agent assessment, not a p-value, measured probability, or statistical confidence interval. Preserve negative and inconclusive results. Keep it to the question actually asked: about three levels and thirty notes, then offer to expand a branch on request. Leave out redundancy, never results.',
  },
  explanation: {
    label: 'Explanation',
    summary: 'How something works today: parts, boundaries, flows, and past decisions.',
    instructions:
      'Describe how the existing system works instead of testing claims. Put the subject and its scope on the goal or question. Use plain notes without a kind for components, modules, and responsibilities, nested by boundary or layer; the title names the part and the detail says what it does, what it talks to, and where it lives. Use decision nodes for design choices already made, with rationale and known tradeoffs in detail. Attach file paths as sources on the note they describe instead of adding evidence nodes; add an evidence node only for a fact a reader would want to verify or that contradicts the apparent design. Use hypotheses only for claims about the design you could not confirm from the code, marked untested. Keep it readable: about three levels and thirty notes, then offer to expand a branch on request.',
  },
} as const;

export type ReasoningProfile = keyof typeof reasoningProfiles;

export function normalizeReasoningProfile(value: unknown): ReasoningProfile {
  return typeof value === 'string' && Object.hasOwn(reasoningProfiles, value)
    ? (value as ReasoningProfile)
    : 'investigation';
}
