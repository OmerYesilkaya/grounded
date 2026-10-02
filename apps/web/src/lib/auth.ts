import { api, ApiError } from "@/lib/api";

export interface SignedInUser {
  id: string;
  email: string;
  /** False until they choose a password: the app asks for one before anything else. */
  passwordSet: boolean;
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

/**
 * Signs in with the email and the password, which the first time is the invite code; throws an
 * ApiError saying why otherwise (403: the pair matches nothing; 429: locked for a while).
 */
export function signIn(email: string, password: string): Promise<SignedInUser> {
  return api<SignedInUser>("/api/auth/sign-in", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

/**
 * Chooses the password (the first time, which ends the invite code) or changes it, given the
 * current one; throws an ApiError saying why otherwise.
 */
export function setPassword(password: string, current?: string): Promise<SignedInUser> {
  return api<SignedInUser>("/api/auth/password", {
    method: "PUT",
    body: JSON.stringify(current === undefined ? { password } : { password, current }),
  });
}

export async function signOut(): Promise<void> {
  await api<undefined>("/api/auth/sign-out", { method: "POST" });
}
