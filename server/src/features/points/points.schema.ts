export function parsePointsRequest(request: Request): void {
  if (new URL(request.url).search) throw new Error("points requests do not accept account parameters");
}
