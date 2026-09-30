import { api, ApiError } from "@/lib/api";

export interface SignedInUser {
  id: string;
  email: string;
}

/** Who is signed in, or null. The answer renews the session cookie (design §4.3). */
export async function getSession(): Promise<SignedInUser | null> {
  try {
    return await api<SignedInUser>("/api/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

/** Signs an invited email in; throws an ApiError saying why otherwise (403: not invited). */
export function signIn(email: string): Promise<SignedInUser> {
  return api<SignedInUser>("/api/auth/sign-in", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function signOut(): Promise<void> {
  await api<undefined>("/api/auth/sign-out", { method: "POST" });
}
