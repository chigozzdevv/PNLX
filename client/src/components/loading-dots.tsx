export function LoadingDots({ label = "Loading" }: { label?: string }) {
  return (
    <span aria-label={label} className="loading-dots" role="status">
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      <span aria-hidden="true" />
    </span>
  );
}
