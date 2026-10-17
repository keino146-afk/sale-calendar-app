import Link from "next/link";

// Where requireAdmin() sends a request whose session or admin check could not
// be verified because of a temporary backend failure. Fixed text only: no
// session, Auth or database code runs here (admin-security.test.ts pins
// this), so it can never redirect back and loop. The session is left as it
// was; going back to /admin checks it again.
export default function AdminUnavailablePage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 pb-12 pt-10">
      <h1 className="text-center text-2xl font-bold">管理画面</h1>
      <p role="alert" className="rounded-2xl bg-amber-50 px-4 py-3 text-center text-sm text-amber-800">
        一時的に管理者情報を確認できません。少し待ってから再度お試しください。
      </p>
      <Link
        href="/admin"
        className="rounded-xl bg-blue-500 px-4 py-2.5 text-center text-[15px] font-semibold text-white"
      >
        管理画面へ戻る
      </Link>
    </main>
  );
}
