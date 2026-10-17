"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

// One of the two Client Components (admin-security.test.ts pins both). It asks
// /admin/presence, the one place that can see the Path=/admin session cookie,
// whether the visitor is an admin, and shows a small "管理画面へ" link only on
// an exact positive answer. Anything else (204, errors, redirects, odd
// bodies) keeps it hidden. Nothing is stored. Convenience only: /admin
// itself still requires an admin session.

export const ADMIN_PRESENCE_PATH = "/admin/presence";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export async function checkAdminPresence(fetchImpl: FetchLike): Promise<boolean> {
  try {
    const response = await fetchImpl(ADMIN_PRESENCE_PATH, {
      method: "GET",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    });
    if (response.status !== 200) return false;
    const body: unknown = await response.json();
    return (
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      Object.keys(body).length === 1 &&
      (body as { isAdmin?: unknown }).isAdmin === true
    );
  } catch {
    return false;
  }
}

export function AdminDashboardLink() {
  return (
    <Link
      href="/admin"
      className="rounded-full border border-black/10 bg-white px-3 py-1 text-xs font-semibold text-blue-600 shadow-sm"
    >
      管理画面へ
    </Link>
  );
}

export function AdminHomeLink() {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let active = true;
    void checkAdminPresence((input, init) => fetch(input, init)).then((result) => {
      if (active) setIsAdmin(result);
    });
    return () => {
      active = false;
    };
  }, []);

  return isAdmin ? <AdminDashboardLink /> : null;
}
