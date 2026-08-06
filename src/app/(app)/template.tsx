/** Remounts on every route change, giving each page a quiet entrance. */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-enter flex-1 flex flex-col min-h-0">{children}</div>;
}
