"use server";

import { redirect } from "next/navigation";
import {
  isSameOriginRequest,
  parseLoginForm,
  signInAdmin,
  signOutAdmin,
} from "@/server/auth/admin-auth";
import {
  ADMIN_HOME_PATH,
  ADMIN_LOGIN_FAILED_PATH,
  ADMIN_LOGIN_PATH,
} from "@/server/auth/admin-session";

// Server Actions are reachable by direct POST, so each one re-checks the
// request itself. redirect() throws, so it is never called inside try/catch.

export async function loginAction(formData: FormData): Promise<void> {
  if (!(await isSameOriginRequest())) redirect(ADMIN_LOGIN_FAILED_PATH);

  const credentials = parseLoginForm(formData);
  const ok = credentials !== null && (await signInAdmin(credentials));
  redirect(ok ? ADMIN_HOME_PATH : ADMIN_LOGIN_FAILED_PATH);
}

export async function logoutAction(): Promise<void> {
  // A cross-site request must not be able to sign the admin out.
  if (!(await isSameOriginRequest())) redirect(ADMIN_HOME_PATH);

  await signOutAdmin();
  redirect(ADMIN_LOGIN_PATH);
}
