import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const AccountInput = z.object({
  id: z.string().uuid().optional(),
  label: z.string().min(1).max(80),
  broker: z.string().min(1).max(120),
  login: z.string().min(1).max(40),
  password: z.string().min(1).max(200).optional(),
  server: z.string().min(1).max(120),
  bridge_url: z.string().url().max(300).optional().or(z.literal("")),
});

export const saveMt5Account = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => AccountInput.parse(v))
  .handler(async ({ data, context }) => {
    const { encryptSecret, newBridgeToken } = await import("@/lib/crypto.server");
    const { supabase, userId } = context;

    if (data.id) {
      const patch: {
        label: string; broker: string; login: string; server: string;
        bridge_url: string | null; password_ciphertext?: string;
      } = {
        label: data.label,
        broker: data.broker,
        login: data.login,
        server: data.server,
        bridge_url: data.bridge_url || null,
      };
      if (data.password) patch.password_ciphertext = encryptSecret(data.password);
      const { error } = await supabase.from("mt5_accounts").update(patch).eq("id", data.id).eq("user_id", userId);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }

    if (!data.password) throw new Error("Password required");
    const { data: row, error } = await supabase
      .from("mt5_accounts")
      .insert({
        user_id: userId,
        label: data.label,
        broker: data.broker,
        login: data.login,
        server: data.server,
        password_ciphertext: encryptSecret(data.password),
        bridge_url: data.bridge_url || null,
        bridge_token: newBridgeToken(),
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row!.id };
  });

export const deleteMt5Account = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("mt5_accounts")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Returns the bridge token + decrypted MT5 credentials for the current user.
// The user is providing credentials to their OWN bridge service — this is
// the read-back path the bridge configuration screen uses to display and
// copy them.
export const getBridgeConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const { decryptSecret } = await import("@/lib/crypto.server");
    const { data: row, error } = await context.supabase
      .from("mt5_accounts")
      .select("id, login, server, broker, bridge_token, password_ciphertext, bridge_url")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .single();
    if (error || !row) throw new Error(error?.message ?? "Not found");
    return {
      id: row.id,
      login: row.login,
      server: row.server,
      broker: row.broker,
      bridge_url: row.bridge_url,
      bridge_token: row.bridge_token,
      password: decryptSecret(row.password_ciphertext),
    };
  });

const CommandInput = z.object({
  account_id: z.string().uuid(),
  command: z.enum(["open", "close", "modify", "close_all", "ping"]),
  payload: z.record(z.any()).default({}),
});

export const sendBridgeCommand = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => CommandInput.parse(v))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("bridge_commands").insert({
      user_id: context.userId,
      account_id: data.account_id,
      command: data.command,
      payload: data.payload,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });