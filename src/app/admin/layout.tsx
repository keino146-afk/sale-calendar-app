import type { Metadata } from "next";

// The admin area must never be indexed.
export const metadata: Metadata = {
  title: "管理画面 | セールカレンダー",
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return children;
}
