const claimedApprovalResponses = new Set<string>();

export function claimApprovalResponse(requestId: string): boolean {
  if (claimedApprovalResponses.has(requestId)) return false;
  claimedApprovalResponses.add(requestId);
  return true;
}

export function releaseApprovalResponse(requestId: string): void {
  claimedApprovalResponses.delete(requestId);
}
