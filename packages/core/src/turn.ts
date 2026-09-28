export type TurnPhase =
  | "prepared"
  | "submitted"
  | "accepted"
  | "tool-wait"
  | "tool-result-delivered"
  | "continuing"
  | "completed"
  | "failed-before-acceptance"
  | "indeterminate-after-acceptance"
  | "cancelled";

const transitions: Readonly<Record<TurnPhase, readonly TurnPhase[]>> = {
  prepared: ["submitted", "cancelled"],
  submitted: ["accepted", "failed-before-acceptance", "cancelled"],
  accepted: ["tool-wait", "continuing", "completed", "indeterminate-after-acceptance", "cancelled"],
  "tool-wait": ["tool-result-delivered", "indeterminate-after-acceptance", "cancelled"],
  "tool-result-delivered": ["continuing", "tool-wait", "completed", "indeterminate-after-acceptance", "cancelled"],
  continuing: ["tool-wait", "completed", "indeterminate-after-acceptance", "cancelled"],
  completed: [],
  "failed-before-acceptance": [],
  "indeterminate-after-acceptance": [],
  cancelled: [],
};

export function transitionTurn(from: TurnPhase, to: TurnPhase): TurnPhase {
  if (!transitions[from].includes(to)) throw new Error(`invalid turn transition: ${from} -> ${to}`);
  return to;
}

/** Only a never-submitted prepared turn may be automatically submitted. */
export function mayAutoSubmit(phase: TurnPhase): boolean {
  return phase === "prepared";
}
