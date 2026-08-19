// Server-only: loads the user's stored Capital.com credentials, decrypts them
// and opens an API session. Credentials and session tokens never leave the server.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { createSession, type CapitalEnv, type CapitalSession, CapitalError } from "@/lib/capital.server";

type DB = SupabaseClient<Database>;

export type CapitalRow = {
  id: string;
  environment: CapitalEnv;
  identifier: string;
  remote_account_id: string | null;
  account_name: string | null;
  currency: string | null;
  gold_epic: string | null;
  gold_name: string | null;
  connection_status: string;
};

export async function getCapitalSession(
  supabase: DB,
  userId: string,
  environment?: CapitalEnv,
): Promise<{ session: CapitalSession; row: CapitalRow }> {
  const { decryptSecret } = await import("@/lib/crypto.server");

  let q = supabase
    .from("capital_accounts")
    .select(
      "id, environment, identifier, api_key_ciphertext, api_password_ciphertext, remote_account_id, account_name, currency, gold_epic, gold_name, connection_status",
    )
    .eq("user_id", userId);
  if (environment) q = q.eq("environment", environment);

  const { data, error } = await q.order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new CapitalError(error.message);
  if (!data) throw new CapitalError("Capital.com credentials are not configured", 400);

  const session = await createSession(
    data.environment as CapitalEnv,
    data.identifier,
    decryptSecret(data.api_key_ciphertext),
    decryptSecret(data.api_password_ciphertext),
  );

  return {
    session,
    row: {
      id: data.id,
      environment: data.environment as CapitalEnv,
      identifier: data.identifier,
      remote_account_id: data.remote_account_id,
      account_name: data.account_name,
      currency: data.currency,
      gold_epic: data.gold_epic,
      gold_name: data.gold_name,
      connection_status: data.connection_status,
    },
  };
}