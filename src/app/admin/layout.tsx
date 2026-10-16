import type { Metadata } from "next";

// The admin area must never be indexed.
export const metadata: Metadata = {
  // absolute: the root title template must not add the site name twice.
  title: { absolute: "管理画面 | セールカレンダー" },
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return children;
}
