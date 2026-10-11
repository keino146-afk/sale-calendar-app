import { connection } from "next/server";
import { loginAction } from "../actions";

export default async function AdminLoginPage({ searchParams }: PageProps<"/admin/login">) {
  await connection();
  const { error } = await searchParams;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 pb-12 pt-10">
      <h1 className="text-center text-2xl font-bold">管理者ログイン</h1>
      {error !== undefined ? (
        <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-center text-sm text-red-700">
          ログインできませんでした
        </p>
      ) : null}
      <form
        action={loginAction}
        className="flex flex-col gap-3 rounded-2xl bg-white px-4 py-5 shadow-sm ring-1 ring-black/5"
      >
        <label className="flex flex-col gap-1 text-sm">
          メールアドレス
          <input
            type="email"
            name="email"
            autoComplete="username"
            required
            maxLength={254}
            className="rounded-xl border border-black/10 px-3 py-2 text-base"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          パスワード
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            maxLength={1024}
            className="rounded-xl border border-black/10 px-3 py-2 text-base"
          />
        </label>
        <button
          type="submit"
          className="mt-1 rounded-xl bg-blue-500 px-4 py-2.5 text-[15px] font-semibold text-white"
        >
          ログイン
        </button>
      </form>
    </main>
  );
}
