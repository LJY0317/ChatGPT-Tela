export interface SetupDriver<Observation, Plan, Applied, Verification> {
  inspect(): Promise<Observation>;
  plan(observation: Observation): Promise<Plan> | Plan;
  apply(plan: Plan): Promise<Applied>;
  verify(applied: Applied): Promise<Verification>;
}

export type SetupResult<Observation, Plan, Applied, Verification> =
  | { readonly mode: "plan"; readonly observation: Observation; readonly plan: Plan }
  | { readonly mode: "applied"; readonly observation: Observation; readonly plan: Plan; readonly applied: Applied; readonly verification: Verification };

export async function executeSetup<Observation, Plan, Applied, Verification>(
  driver: SetupDriver<Observation, Plan, Applied, Verification>,
  options: { readonly apply: boolean },
): Promise<SetupResult<Observation, Plan, Applied, Verification>> {
  const observation = await driver.inspect();
  const plan = await driver.plan(observation);
  if (!options.apply) return { mode: "plan", observation, plan };
  const applied = await driver.apply(plan);
  const verification = await driver.verify(applied);
  return { mode: "applied", observation, plan, applied, verification };
}

export * from "./codex-process-route";
export * from "./multi-profile";
