export const STALE_MARGIN_ROOT_CODE = "STALE_MARGIN_ROOT" as const;

export class StaleMarginRootError extends Error {
  readonly code = STALE_MARGIN_ROOT_CODE;

  constructor() {
    super("intent margin root is not current");
    this.name = "StaleMarginRootError";
  }
}
