// Activation of a just-created login, kept apart from index.ts so it can be
// tested without the Edge runtime's environment.
//
// handle_new_user (migration 20261022023000) creates every new login as an
// inactive, login-blocked driver named 'Pending user <id>'. The admin's chosen
// name, role and phone are set and the user is activated through
// admin_update_profile, called with the CALLING admin's own client (never the
// service role), so that function's active-admin check and the profile guards
// still decide. The idempotency key names the new user's id plus a random part,
// so it can never land on another user or be used up in advance.

// Loose shape so the caller's SupabaseClient (or a test double) fits without
// importing its generics.
export interface RpcClientLike {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface NewUserProfile {
  userId: string;
  fullName: string;
  role: string;
  phone?: string | null;
}

// Supabase returns null data (not an error) when a call is denied, so null is
// a failure, never a success (the same local helper as process-blend-ticket).
function assertRpcResult<T>(data: unknown, rpcName: string): T {
  if (data === null || data === undefined) {
    throw new Error(`${rpcName} returned no data`);
  }
  return data as T;
}

// Unguessable as well as user-scoped: idempotency keys are shared across
// actors, so a key predictable from the user id could be used up first by
// another admin call and replay its cached success here.
export function activationKeyFor(userId: string): string {
  return `create-user-activate:${userId}:${crypto.randomUUID()}`;
}

// Resolves to null when the user is active with the chosen name and role, or to
// the reason it is not. Never throws: the login already exists either way, and
// the caller reports the outcome instead of failing the whole request.
export async function activateNewUser(
  callerClient: RpcClientLike,
  profile: NewUserProfile,
): Promise<string | null> {
  try {
    const { data, error } = await callerClient.rpc("admin_update_profile", {
      target_user_id: profile.userId,
      new_role: profile.role,
      new_full_name: profile.fullName,
      new_phone: profile.phone || null,
      new_is_active: true,
      p_idempotency_key: activationKeyFor(profile.userId),
    });
    if (error) return error.message;
    const result = assertRpcResult<{ success?: unknown; error?: unknown }>(
      data,
      "admin_update_profile",
    );
    if (result.success === true) return null;
    return typeof result.error === "string" && result.error
      ? result.error
      : "Activation returned no result";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
