/** Empty node_group means all nodes. Malformed/non-string values fail closed. */
export function userAssignedToNode(
  nodeGroup: string | null,
  nodeId: string,
  accountAlias: string,
): boolean {
  if (nodeGroup === null || nodeGroup.trim() === "") return true;
  try {
    const values = JSON.parse(nodeGroup) as unknown;
    if (!Array.isArray(values)) return false;
    if (values.length === 0) return true;
    return values.some(
      (value) =>
        typeof value === "string" &&
        (value === nodeId || value === accountAlias),
    );
  } catch {
    return false;
  }
}
