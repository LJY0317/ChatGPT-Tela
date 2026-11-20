/** Match the structured output of systemctl show used for service ownership. */
export function systemdUnitFixture(fragmentPath?: string, active = "inactive", dropIns = "") {
  return {
    exitCode: fragmentPath ? 0 : 1,
    stdout: `LoadState=${fragmentPath ? "loaded" : "not-found"}\nActiveState=${active}\nFragmentPath=${fragmentPath ?? ""}\nDropInPaths=${dropIns}\n`,
    stderr: "",
  };
}
