import { connection } from "next/server";
import { logoutAction } from "./actions";
import { requireAdmin } from "@/server/auth/admin-session";

export default async function AdminPage() {
  // Both stay outside try/catch: connection() stops build-time rendering and
  // requireAdmin() redirects by throwing.
  await connection();
  await requireAdmin();

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 pb-12 pt-6">
      <h1 className="text-center text-2xl font-bold">管理画面</h1>
      <section className="flex flex-col items-center gap-4 rounded-2xl bg-white px-4 py-6 shadow-sm ring-1 ring-black/5">
        <p className="text-sm text-foreground/70">ログイン済み</p>
        <form action={logoutAction}>
          <button
            type="submit"
            className="rounded-full border border-black/10 bg-white px-5 py-2 text-sm font-medium"
          >
            ログアウト
          </button>
        </form>
      </section>
    </main>
  );
}
