import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { saveMt5Account, deleteMt5Account, getBridgeConfig } from "@/lib/mt5.functions";
import { toast } from "sonner";
import { Copy, Trash2, Plus, Eye, EyeOff } from "lucide-react";

export const Route = createFileRoute("/_authenticated/accounts")({
  component: AccountsPage,
});

type Account = {
  id: string; label: string; broker: string; login: string; server: string;
  bridge_url: string | null; connection_status: string;
};

function AccountsPage() {
  const [rows, setRows] = useState<Account[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [bridgeConfig, setBridgeConfig] = useState<Awaited<ReturnType<typeof getBridgeConfig>> | null>(null);
  const [showPw, setShowPw] = useState(false);

  const save = useServerFn(saveMt5Account);
  const del = useServerFn(deleteMt5Account);
  const getConf = useServerFn(getBridgeConfig);

  const reload = async () => {
    const { data } = await supabase
      .from("mt5_accounts")
      .select("id, label, broker, login, server, bridge_url, connection_status")
      .order("created_at");
    setRows((data ?? []) as Account[]);
  };
  useEffect(() => { reload(); }, []);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const payload = {
      id: editing?.id,
      label: String(fd.get("label") ?? ""),
      broker: String(fd.get("broker") ?? ""),
      login: String(fd.get("login") ?? ""),
      server: String(fd.get("server") ?? ""),
      password: (fd.get("password") as string) || undefined,
      bridge_url: String(fd.get("bridge_url") ?? ""),
    };
    try {
      await save({ data: payload });
      toast.success(editing ? "Account updated" : "Account connected");
      setShowForm(false);
      setEditing(null);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this account? All associated data will be removed.")) return;
    await del({ data: { id } });
    toast.success("Account removed");
    reload();
  };

  const showBridge = async (id: string) => {
    try {
      const c = await getConf({ data: { id } });
      setBridgeConfig(c);
      setShowPw(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load config");
    }
  };

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
          <p className="text-sm text-muted-foreground">Connect your MetaTrader 5 trading accounts.</p>
        </div>
        <button
          onClick={() => { setEditing(null); setShowForm(true); }}
          className="ml-auto inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> Add account
        </button>
      </div>

      <div className="rounded-lg border border-border bg-card divide-y divide-border">
        {rows.length === 0 && (
          <div className="p-10 text-center text-sm text-muted-foreground">No accounts yet.</div>
        )}
        {rows.map((r) => (
          <div key={r.id} className="p-4 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">
                {r.label} <span className="text-muted-foreground font-normal">· {r.broker}</span>
              </div>
              <div className="text-xs text-muted-foreground truncate">
                #{r.login} · {r.server} · {r.connection_status}
              </div>
            </div>
            <button
              onClick={() => showBridge(r.id)}
              className="text-xs h-8 px-3 rounded-md border border-border hover:bg-accent"
            >
              Bridge config
            </button>
            <button
              onClick={() => { setEditing(r); setShowForm(true); }}
              className="text-xs h-8 px-3 rounded-md border border-border hover:bg-accent"
            >
              Edit
            </button>
            <button
              onClick={() => remove(r.id)}
              className="text-xs h-8 w-8 grid place-items-center rounded-md border border-border hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-foreground/20 backdrop-blur-sm grid place-items-center z-30 p-4" onClick={() => setShowForm(false)}>
          <form
            onSubmit={submit}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-lg border border-border bg-card p-6 space-y-3"
          >
            <h2 className="text-lg font-semibold">{editing ? "Edit account" : "Connect MT5 account"}</h2>
            <Field name="label" label="Label" defaultValue={editing?.label} placeholder="Main FTMO" required />
            <Field name="broker" label="Broker name" defaultValue={editing?.broker} placeholder="ICMarkets" required />
            <div className="grid grid-cols-2 gap-3">
              <Field name="login" label="MT5 Login" defaultValue={editing?.login} placeholder="1234567" required />
              <Field name="server" label="Server" defaultValue={editing?.server} placeholder="ICMarkets-Demo" required />
            </div>
            <Field
              name="password"
              label={editing ? "Password (leave blank to keep)" : "Password"}
              type="password"
              required={!editing}
            />
            <Field
              name="bridge_url"
              label="Bridge URL (optional)"
              defaultValue={editing?.bridge_url ?? ""}
              placeholder="https://your-bridge.onrender.com"
            />
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="flex-1 h-10 rounded-md border border-border text-sm hover:bg-accent"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
              >
                Save
              </button>
            </div>
          </form>
        </div>
      )}

      {bridgeConfig && (
        <div className="fixed inset-0 bg-foreground/20 backdrop-blur-sm grid place-items-center z-30 p-4" onClick={() => setBridgeConfig(null)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-lg border border-border bg-card p-6 space-y-4"
          >
            <div>
              <h2 className="text-lg font-semibold">Bridge configuration</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Paste these into <code className="text-xs">bridge/.env</code> on your Render service or VPS.
                Never share the token — anyone with it can post trades to this account.
              </p>
            </div>
            <CopyRow label="ACCOUNT_ID" value={bridgeConfig.id} onCopy={copy} />
            <CopyRow label="BRIDGE_TOKEN" value={bridgeConfig.bridge_token ?? ""} onCopy={copy} mono />
            <CopyRow label="MT5_LOGIN" value={bridgeConfig.login} onCopy={copy} />
            <CopyRow label="MT5_SERVER" value={bridgeConfig.server} onCopy={copy} />
            <div>
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                <span>MT5_PASSWORD</span>
                <button onClick={() => setShowPw((s) => !s)} className="hover:text-foreground inline-flex items-center gap-1">
                  {showPw ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  {showPw ? "Hide" : "Show"}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 h-9 px-3 rounded-md bg-muted text-xs grid items-center overflow-hidden">
                  {showPw ? bridgeConfig.password : "•".repeat(Math.min(bridgeConfig.password.length, 16))}
                </code>
                <button
                  onClick={() => copy(bridgeConfig.password, "Password")}
                  className="h-9 w-9 grid place-items-center rounded-md border border-border hover:bg-accent"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <button
              onClick={() => setBridgeConfig(null)}
              className="w-full h-10 rounded-md border border-border text-sm hover:bg-accent"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const { label, ...rest } = props;
  return (
    <label className="block">
      <span className="block text-xs text-muted-foreground mb-1">{label}</span>
      <input
        {...rest}
        className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  );
}

function CopyRow({ label, value, onCopy, mono }: { label: string; value: string; onCopy: (v: string, l: string) => void; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <code className={"flex-1 h-9 px-3 rounded-md bg-muted text-xs grid items-center overflow-hidden truncate " + (mono ? "font-mono" : "")}>
          {value}
        </code>
        <button
          onClick={() => onCopy(value, label)}
          className="h-9 w-9 grid place-items-center rounded-md border border-border hover:bg-accent"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}