CREATE TABLE IF NOT EXISTS public.broker_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  active_broker TEXT CHECK (active_broker IN ('capital','mt5')),
  auto_trading_enabled BOOLEAN NOT NULL DEFAULT false,
  live_confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.broker_settings TO authenticated;
GRANT ALL ON public.broker_settings TO service_role;
ALTER TABLE public.broker_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own broker settings" ON public.broker_settings;
CREATE POLICY "Users manage own broker settings" ON public.broker_settings FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.capital_accounts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  environment TEXT NOT NULL DEFAULT 'demo' CHECK (environment IN ('demo','live')),
  identifier TEXT NOT NULL,
  api_key_ciphertext TEXT NOT NULL,
  api_password_ciphertext TEXT NOT NULL,
  remote_account_id TEXT,
  account_name TEXT,
  currency TEXT,
  gold_epic TEXT,
  gold_name TEXT,
  connection_status TEXT NOT NULL DEFAULT 'disconnected',
  last_connected_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, environment)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.capital_accounts TO authenticated;
GRANT ALL ON public.capital_accounts TO service_role;
ALTER TABLE public.capital_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own capital accounts" ON public.capital_accounts;
CREATE POLICY "Users manage own capital accounts" ON public.capital_accounts FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS update_broker_settings_updated_at ON public.broker_settings;
CREATE TRIGGER update_broker_settings_updated_at BEFORE UPDATE ON public.broker_settings FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS update_capital_accounts_updated_at ON public.capital_accounts;
CREATE TRIGGER update_capital_accounts_updated_at BEFORE UPDATE ON public.capital_accounts FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();